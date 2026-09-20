import {
  CodeSandbox,
  Sandbox,
  VMTier,
  type HostToken,
  type SandboxClient as ConnectedClient,
  type SandboxInfo,
  type SandboxPrivacy,
} from "@codesandbox/sdk";

export { VMTier };
export type { Sandbox, SandboxInfo, ConnectedClient };

export interface ExecResult {
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number | null;
}

export interface PreviewTarget {
  url: string | null;
}

export interface ResumeResult {
  sandboxId: string;
  bootupType: Sandbox["bootupType"];
  isUpToDate: boolean;
  setupCompleted: boolean;
}

const DEFAULT_HIBERNATION_TIMEOUT_SECONDS = 30;
const DEFAULT_VM_TIER = VMTier.Micro;

export interface CreateSandboxOptions {
  template?: string;
  vmTier?: VMTier;
  hibernationTimeoutSeconds?: number;
  automaticWakeupConfig?: { http: boolean; websocket: boolean };
  privacy?: SandboxPrivacy;
}

export interface HostPreview {
  token: HostToken;
  url: string;
  headers: Record<string, string>;
}

export class CodeSandboxClient {
  private sdk: CodeSandbox;
  private sandbox: Sandbox | null = null;
  private client: ConnectedClient | null = null;
  private sandboxId: string | null = null;

  constructor(apiToken?: string) {
    this.sdk = new CodeSandbox(apiToken);
  }

  async createSandbox(
    templateId: string,
    opts: CreateSandboxOptions = {}
  ): Promise<{ sandboxId: string; editorUrl: string }> {
    const vmTier = opts.vmTier ?? DEFAULT_VM_TIER;
    const hibernationTimeoutSeconds = opts.hibernationTimeoutSeconds ?? DEFAULT_HIBERNATION_TIMEOUT_SECONDS;
    const privacy = opts.privacy ?? "public";
    const automaticWakeupConfig = opts.automaticWakeupConfig ?? { http: true, websocket: false };

    const sandbox = await this.sdk.sandboxes.create({
      id: templateId || undefined,
      vmTier,
      hibernationTimeoutSeconds,
      automaticWakeupConfig,
      privacy,
    });
    const client = await sandbox.connect();

    this.sandbox = sandbox;
    this.client = client;
    this.sandboxId = sandbox.id;

    // Wait until the sandbox is fully booted. `sandbox.bootupType` is the live
    // typed getter (SandboxInfo from `sandboxes.get()` is metadata-only and has
    // no bootupType). CLEAN/FORK boots run setup, which we wait for step by
    // step; anything else is polled until it reports RUNNING/RESUME.
    let bootupType = sandbox.bootupType;
    if (bootupType === "CLEAN" || bootupType === "FORK") {
      for (const step of client.setup.getSteps()) {
        await step.waitUntilComplete();
      }
      bootupType = "RUNNING";
    }
    const maxPoll = 60;
    let pollCount = 0;
    while (bootupType !== "RUNNING" && bootupType !== "RESUME" && pollCount < maxPoll) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCount++;
      try {
        bootupType = sandbox.bootupType;
      } catch {
        break;
      }
    }

    return { sandboxId: sandbox.id, editorUrl: client.editorUrl };
  }

  async resumeSandbox(sandboxId: string): Promise<ResumeResult> {
    const sandbox = await this.sdk.sandboxes.resume(sandboxId);
    const client = await sandbox.connect();

    this.sandbox = sandbox;
    this.client = client;
    this.sandboxId = sandbox.id;

    let setupCompleted = false;
    if (sandbox.bootupType === "CLEAN") {
      const steps = client.setup.getSteps();
      for (const step of steps) {
        await step.waitUntilComplete();
      }
      setupCompleted = true;
    }

    return {
      sandboxId: sandbox.id,
      bootupType: sandbox.bootupType,
      isUpToDate: sandbox.isUpToDate,
      setupCompleted,
    };
  }

  async openSandbox(sandboxId: string): Promise<ResumeResult> {
    return this.resumeSandbox(sandboxId);
  }

  /**
   * Restart the sandbox (shutdown + start). Files in the project directory are
   * preserved and setup runs again. This is the documented way to update the
   * VM agent: Sandboxes.restart — "Will resolve once the sandbox is restarted
   * with its setup running." (https://codesandbox.stream/docs/sdk/restart)
   */
  async restartSandbox(sandboxId: string): Promise<ResumeResult> {
    const sandbox = await this.sdk.sandboxes.restart(sandboxId);
    const client = await sandbox.connect();
    this.sandbox = sandbox;
    this.client = client;
    this.sandboxId = sandbox.id;
    // A restart always re-runs setup; wait for CLEAN-boot setup steps.
    if (sandbox.bootupType === "CLEAN") {
      for (const step of client.setup.getSteps()) {
        await step.waitUntilComplete();
      }
    }
    return {
      sandboxId: sandbox.id,
      bootupType: sandbox.bootupType,
      isUpToDate: sandbox.isUpToDate,
      setupCompleted: true,
    };
  }

  async startSandbox(sandboxId: string): Promise<ResumeResult> {
    return this.resumeSandbox(sandboxId);
  }

  async getSandboxInfo(sandboxId: string): Promise<SandboxInfo | null> {
    try {
      return await this.sdk.sandboxes.get(sandboxId);
    } catch {
      return null;
    }
  }

  async listRunning(): Promise<{ concurrentVmCount: number; concurrentVmLimit: number }> {
    const running = await this.sdk.sandboxes.listRunning();
    return {
      concurrentVmCount: running.concurrentVmCount,
      concurrentVmLimit: running.concurrentVmLimit,
    };
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    try {
      await this.sdk.sandboxes.delete(sandboxId);
    } catch {
      // Ignore not-found errors.
    }
  }

  async hibernateSandbox(sandboxId: string): Promise<void> {
    await this.sdk.sandboxes.hibernate(sandboxId);
    this.client = null;
    this.sandbox = null;
    this.sandboxId = null;
  }

  /**
   * Fork a sandbox safely.
   *
   * Per the SDK docs: forking a HIBERNATED sandbox takes 1-3s, while forking a
   * RUNNING sandbox is a "Live Fork" (limited, degrades performance). So we
   * hibernate the source first unless it is already hibernated/archived.
   * `sandboxes.create({ id })` is the documented fork path (Sandboxes.fork is deprecated).
   */
  async forkSandbox(sandboxId: string): Promise<{ sandboxId: string; editorUrl: string }> {
    if (!sandboxId) {
      throw new Error("forkSandbox requires a source sandboxId");
    }
    // Cheap metadata lookup first; throws if the sandbox is not found/accessible.
    await this.sdk.sandboxes.get(sandboxId);

    try {
      // Resume first (docs: "Forking an ARCHIVED sandbox: 20-60 seconds. Resume
      // parent first."), then hibernate so the fork runs from cold storage.
      // For an already-hibernated parent this is a quick wake + sleep; for a
      // RUNNING parent this converts the "Live Fork" into a fast cold fork.
      await this.sdk.sandboxes.resume(sandboxId);
      await this.sdk.sandboxes.hibernate(sandboxId);
    } catch (error: any) {
      // A sandbox that is already stopped/archived may refuse resume; that is
      // fine — hibernate() will no-op or the fork proceeds from cold state.
      console.warn(`[codesandbox] pre-fork hibernate skipped: ${error?.message ?? error}`);
    }

    const sandbox = await this.sdk.sandboxes.create({ id: sandboxId });
    const client = await sandbox.connect();
    this.sandbox = sandbox;
    this.client = client;
    this.sandboxId = sandbox.id;
    return { sandboxId: sandbox.id, editorUrl: client.editorUrl };
  }

  async mkdir(path: string): Promise<void> {
    const client = await this.getClient();
    await client.fs.mkdir(path, true);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const client = await this.getClient();
    await client.fs.writeTextFile(path, content);
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const client = await this.getClient();
      return await client.fs.readTextFile(path);
    } catch {
      return null;
    }
  }

  async readDir(path: string): Promise<FileEntry[]> {
    try {
      const client = await this.getClient();
      const entries = await client.fs.readdir(path);
      return entries.map((entry) => ({
        name: entry.name,
        path: path === "/" ? `/${entry.name}` : `${path.replace(/\/$/, "")}/${entry.name}`,
        kind: entry.type === "directory" ? "directory" : "file",
        size: null,
      }));
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean } | null> {
    try {
      const client = await this.getClient();
      const value = await client.fs.stat(path);
      return { size: value.size, isDirectory: value.type === "directory" };
    } catch {
      return null;
    }
  }

  async remove(path: string): Promise<void> {
    const client = await this.getClient();
    await client.fs.remove(path, true);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const client = await this.getClient();
    await client.fs.rename(oldPath, newPath, true);
  }

  async exec(command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult> {
    const client = await this.getClient();
    const startedAt = Date.now();
    try {
      const output = await client.commands.run(command, {
        cwd: options?.cwd,
        env: options?.env,
      });
      return {
        stdout: output,
        stderr: null,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      };
    } catch (error: any) {
      return {
        stdout: null,
        stderr: error?.output ?? error?.message ?? "Command execution failed",
        exitCode: error?.exitCode ?? null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      };
    }
  }

  async searchFiles(dir: string, pattern: string): Promise<string[]> {
    const result = await this.exec(`find . -type f -name ${shellQuote(pattern)} 2>/dev/null || true`, {
      cwd: dir,
      timeoutMs: 30_000,
    });
    if (!result.stdout) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((relativePath) => joinPath(dir, relativePath));
  }

  async searchContent(dir: string, pattern: string): Promise<{ path: string; line: number; content: string }[]> {
    const result = await this.exec(
      `grep -rIn -- ${shellQuote(pattern)} . 2>/dev/null | head -100 || true`,
      { cwd: dir, timeoutMs: 30_000 }
    );
    if (!result.stdout) return [];
    return result.stdout.split("\n").filter(Boolean).map((line) => {
      const firstColon = line.indexOf(":");
      const secondColon = line.indexOf(":", firstColon + 1);
      const path = secondColon > 0 ? line.slice(0, secondColon) : line;
      const lineText = secondColon > 0 ? line.slice(secondColon + 1) : "";
      return {
        path: joinPath(dir, path),
        line: 0,
        content: lineText,
      };
    });
  }

  async getGitStatus(cwd: string): Promise<{
    branch: string | null;
    staged: string[];
    modified: string[];
    untracked: string[];
    raw: string;
  }> {
    const branch = await this.exec(`git rev-parse --abbrev-ref HEAD 2>/dev/null || true`, { cwd });
    const status = await this.exec(`git status --porcelain 2>/dev/null || true`, { cwd });
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    for (const line of (status.stdout ?? "").split("\n")) {
      if (line.length < 4) continue;
      const state = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (!file) continue;
      if (state === "??") untracked.push(file);
      else if (state[0] !== " " && state[0] !== "?") staged.push(file);
      else if (state[1] !== " " && state[1] !== "?") modified.push(file);
    }
    return {
      branch: branch.stdout?.trim() || null,
      staged,
      modified,
      untracked,
      raw: status.stdout ?? "",
    };
  }

  async getGitDiff(cwd: string): Promise<{ staged: string; unstaged: string }> {
    const [staged, unstaged] = await Promise.all([
      this.exec(`git diff --cached 2>/dev/null || true`, { cwd }),
      this.exec(`git diff 2>/dev/null || true`, { cwd }),
    ]);
    return { staged: staged.stdout ?? "", unstaged: unstaged.stdout ?? "" };
  }

  async startDevServer(
    cwd: string,
    command: string,
    port: number,
    opts: { taskName?: string; restart?: boolean } = {}
  ): Promise<{ taskId: string; reused: boolean }> {
    const client = await this.getClient();
    const taskName = opts.taskName ?? "dev";
    const tasks = await client.tasks.getAll();
    const existing = tasks.find((task) => task.name === taskName || task.name === "Dev Server");
    if (existing && !opts.restart && existing.status !== "IDLE") {
      return { taskId: existing.id, reused: true };
    }
    if (existing) {
      if (opts.restart) await existing.restart();
      else await existing.run();
      return { taskId: existing.id, reused: true };
    }
    throw new Error(`Task "${taskName}" is not defined in .codesandbox/tasks.json`);
  }

  async waitForPort(port: number, timeoutMs = 45_000): Promise<boolean> {
    try {
      await this.getClient().then((client) => client.ports.waitForPort(port, { timeoutMs }));
      return true;
    } catch {
      return false;
    }
  }

  async stopDevServer(taskId?: string): Promise<void> {
    const client = await this.getClient();
    const tasks = await client.tasks.getAll();
    const task = taskId ? tasks.find((value) => value.id === taskId) : tasks.find((value) => value.name === "dev");
    await task?.stop();
  }

  async getPreviewUrl(port: number): Promise<PreviewTarget> {
    const client = await this.getClient();
    const value = await client.ports.get(port);
    return { url: value ? `https://${value.host}` : null };
  }

  async createHostPreview(sandboxId: string, port: number, expiresHours = 1): Promise<HostPreview> {
    // HostTokens.createToken requires `expiresAt` (HostTokens.d.ts):
    //   createToken(sandboxId: string, opts: { expiresAt: Date }): Promise<HostToken>
    const token = await this.sdk.hosts.createToken(sandboxId, {
      expiresAt: new Date(Date.now() + expiresHours * 60 * 60 * 1000),
    });
    return {
      token,
      url: this.sdk.hosts.getUrl(token, port),
      headers: this.sdk.hosts.getHeaders(token),
    };
  }

  private async getClient(): Promise<ConnectedClient> {
    if (!this.client) {
      throw new Error("No sandbox connected — call createSandbox, resumeSandbox, or openSandbox first");
    }
    return this.client;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function joinPath(directory: string, relativePath: string): string {
  const base = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  return `${base}/${relativePath.replace(/^\.\//, "")}`;
}