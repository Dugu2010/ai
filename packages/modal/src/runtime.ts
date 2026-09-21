/**
 * Modal implementation of DAI's runtime contract.
 *
 * Shape of the design, per Modal's current documentation:
 *  - Durability lives in a Volume mounted at /workspace. A finished Sandbox is
 *    gone for good (Modal cannot resume a finished Sandbox as a paused VM), so
 *    losing compute never loses source files.
 *  - Sandbox instances are acquired once per agent run and reused, not created
 *    per command. With no `command`, a Sandbox "sleeps indefinitely until
 *    timeout or termination" and is driven entirely through exec().
 *  - `idleTimeoutMs` lets Modal reclaim idle compute; no keepalive pings, since
 *    Modal counts open TCP connections as activity.
 */

import type { Probe as ProbeType, Sandbox } from "modal";
import { Probe } from "modal";
import type { ModalRuntimeConfig } from "./config.js";
import { sandboxName, volumeSubPath } from "./config.js";
import { READ_BATCH_MARKER, READ_BATCH_SCRIPT } from "./read-batch-script.js";
import { RESTORE_MARKER, RESTORE_SCRIPT } from "./restore-script.js";
import { RuntimeOperationError, isFailure, toRuntimeError } from "./errors.js";
import type { ModalProvider } from "./provider.js";
import type {
  AcquireOptions,
  BatchReadResult,
  DevServerHandle,
  ExecResult,
  FileEntry,
  PreviewTarget,
  FileMutation,
  MutationResult,
  RuntimeService,
  RuntimeState,
  Workspace,
} from "./types.js";

const WORKSPACE = "/workspace";
/** Where the whole shared Volume is mounted for maintenance Sandboxes. */
const VOLUME_ROOT = "/mnt/dai-volumes";
/** Whole seconds only: Modal rejects sub-second timeouts on some fields. */
function ceilSecond(ms: number): number {
  return Math.max(1_000, Math.ceil(ms / 1_000) * 1_000);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function joinPath(dir: string, relative: string): string {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${base}/${relative.replace(/^\.\//, "")}`;
}

export interface WorkspaceOptions {
  sandbox: Sandbox;
  config: ModalRuntimeConfig;
}

export class ModalWorkspace implements Workspace {
  private readonly sandbox: Sandbox;
  private readonly config: ModalRuntimeConfig;
  private closed = false;

  constructor(options: WorkspaceOptions) {
    this.sandbox = options.sandbox;
    this.config = options.config;
  }

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  /** Run an argv array inside the Sandbox and collect both streams + exit code. */
  private async runArgv(
    argv: string[],
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; pty?: boolean } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    const timeoutMs = ceilSecond(opts.timeoutMs ?? this.config.execTimeoutMs);
    try {
      const proc = await this.sandbox.exec(argv, {
        mode: "text",
        // Explicit pipes keep stdout and stderr separable; Modal's own command
        // router otherwise merges them for some invocations.
        stdout: "pipe",
        stderr: "pipe",
        workdir: opts.cwd ?? this.config.workspacePath,
        timeoutMs,
        env: opts.env,
        pty: opts.pty ?? false,
      });
      // Drain both streams concurrently before waiting, or a chatty command can
      // fill the buffer and deadlock the process.
      const [stdout, stderr] = await Promise.all([proc.stdout.readText(), proc.stderr.readText()]);
      const exitCode = await proc.wait();
      return { stdout, stderr, exitCode, timedOut: false };
    } catch (error) {
      // Modal can report a deadline breach either when the command is issued or
      // while its output is read, so treat both the same: a timed-out command
      // still has to give the agent a usable result.
      if (isFailure(error, "timeout")) {
        return {
          stdout: "",
          stderr: `Command timed out after ${timeoutMs}ms`,
          exitCode: null,
          timedOut: true,
        };
      }
      throw toRuntimeError(error, `Command failed: ${argv.slice(-1)[0] ?? argv[0] ?? ""}`);
    }
  }

  async exec(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<ExecResult> {
    const startedAt = Date.now();
    // A single shell string is the agent's command contract (`npm i && npm t`),
    // so it runs through bash. The string is never built from filesystem
    // responses, and it executes inside an isolated Sandbox, not on the backend.
    const result = await this.runArgv(["/bin/bash", "-lc", command], opts);
    return {
      stdout: result.stdout || null,
      // A non-zero exit puts the diagnostics in stderr, matching the previous
      // provider's ExecResult shape so tool formatting stayed unchanged.
      stderr: result.stderr || null,
      exitCode: result.timedOut ? null : result.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: result.timedOut,
    };
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await this.sandbox.filesystem.readText(path);
    } catch (error) {
      if (isFailure(error, "not_found")) return null;
      throw toRuntimeError(error, `Unable to read ${path}`);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    try {
      // Note the SDK's argument order: payload first, destination second.
      await this.sandbox.filesystem.writeText(content, path);
    } catch (error) {
      if (isFailure(error, "not_found", "not_a_directory")) {
        // Parent directories are not implicit; create them and retry once.
        const parent = path.slice(0, path.lastIndexOf("/")) || "/";
        try {
          await this.sandbox.filesystem.makeDirectory(parent, { createParents: true });
        } catch (mkdirError) {
          throw toRuntimeError(mkdirError, `Unable to create directory ${parent}`);
        }
        await this.sandbox.filesystem.writeText(content, path);
        return;
      }
      throw toRuntimeError(error, `Unable to write ${path}`);
    }
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    try {
      const entries = await this.sandbox.filesystem.listFiles(path);
      return entries.map((entry) => ({
        name: entry.name,
        path: path === "/" || path === "" ? `/${entry.name}` : joinPath(path, entry.name),
        kind: entry.type,
        size: entry.size,
      }));
    } catch (error) {
      if (isFailure(error, "not_found")) return [];
      throw toRuntimeError(error, `Unable to list ${path}`);
    }
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean } | null> {
    try {
      const info = await this.sandbox.filesystem.stat(path);
      return { size: info.size, isDirectory: info.type === "directory" };
    } catch (error) {
      if (isFailure(error, "not_found")) return null;
      throw toRuntimeError(error, `Unable to stat ${path}`);
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.sandbox.filesystem.remove(path, { recursive: true });
    } catch (error) {
      throw toRuntimeError(error, `Unable to remove ${path}`);
    }
  }

  /** @see Workspace.applyFileMutations */
  async applyFileMutations(
    entries: FileMutation[],
    opts: { timeoutMs?: number } = {}
  ): Promise<MutationResult[]> {
    if (entries.length === 0) return [];
    const payload = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
    const result = await this.runArgv(["/usr/bin/python3", "-c", RESTORE_SCRIPT, "dai-restore", payload], {
      timeoutMs: opts.timeoutMs,
    });
    if (result.timedOut) {
      throw new RuntimeOperationError("Batched file mutation timed out", "timeout");
    }
    const markerAt = result.stdout.lastIndexOf(RESTORE_MARKER);
    if (markerAt === -1) {
      throw new RuntimeOperationError(
        `Batched mutation returned no result: ${(result.stderr || result.stdout).slice(0, 300)}`,
        "rejected"
      );
    }
    try {
      const parsed = JSON.parse(result.stdout.slice(markerAt + RESTORE_MARKER.length)) as MutationResult[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      throw new RuntimeOperationError(
        `Unable to parse mutation result: ${error instanceof Error ? error.message : String(error)}`,
        "rejected"
      );
    }
  }

  /** Read many paths in one command; see `Workspace.readFilesBatch`. */
  async readFilesBatch(paths: string[]): Promise<Record<string, BatchReadResult>> {
    if (paths.length === 0) return {};
    const payload = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
    const result = await this.runArgv(["/usr/bin/python3", "-c", READ_BATCH_SCRIPT, "dai-read", payload]);
    if (result.timedOut) {
      throw new RuntimeOperationError("Batch read timed out", "timeout");
    }
    const markerAt = result.stdout.lastIndexOf(READ_BATCH_MARKER);
    if (markerAt === -1) {
      throw new RuntimeOperationError(
        `Batch read returned no result: ${(result.stderr || result.stdout).slice(0, 200)}`,
        "rejected"
      );
    }
    let decoded: string;
    try {
      decoded = Buffer.from(result.stdout.slice(markerAt + READ_BATCH_MARKER.length).trim(), "base64").toString("utf8");
    } catch (error) {
      throw new RuntimeOperationError("Batch read returned unreadable data", "rejected");
    }
    const raw = JSON.parse(decoded) as Record<string, {
      exists?: boolean; size?: number; encoding?: string; data?: string; error?: string;
    }>;
    const outcomes: Record<string, BatchReadResult> = {};
    for (const [path, entry] of Object.entries(raw)) {
      if (entry.error) {
        outcomes[path] = { error: entry.error };
        continue;
      }
      if (!entry.exists) {
        outcomes[path] = { exists: false };
        continue;
      }
      const bytes = Buffer.from(entry.data ?? "", "base64");
      const text = bytes.toString("utf8");
      // A round-trip check, not a heuristic: if re-encoding the decoded text does
      // not reproduce the bytes, undo could not restore this file faithfully.
      const isText = Buffer.from(text, "utf8").equals(bytes);
      outcomes[path] = {
        exists: true,
        isText,
        size: entry.size ?? bytes.length,
        content: isText ? text : null,
        binary: isText ? null : entry.data ?? null,
      };
    }
    return outcomes;
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.sandbox.filesystem.makeDirectory(path, { createParents: true });
    } catch (error) {
      if (isFailure(error, "already_exists", "permission_denied")) return;
      throw toRuntimeError(error, `Unable to create directory ${path}`);
    }
  }

  /** `mv` as argv: no shell string is built from the caller's paths. */
  async rename(from: string, to: string): Promise<void> {
    const result = await this.runArgv(["/bin/mv", "--", from, to]);
    if (result.exitCode !== 0) {
      throw new RuntimeOperationError(
        `Unable to move ${from} to ${to}: ${result.stderr || `exit ${result.exitCode}`}`,
        result.exitCode === 1 ? "invalid" : "rejected"
      );
    }
  }

  async searchFiles(dir: string, pattern: string): Promise<string[]> {
    const result = await this.runArgv([
      "/bin/bash",
      "-lc",
      'find . -maxdepth 12 -type f -name "$1" -print 2>/dev/null | head -200',
      "search",
      pattern,
    ]);
    if (!result.stdout) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((relative) => joinPath(dir, relative));
  }

  async searchContent(dir: string, pattern: string): Promise<{ path: string; line: number; content: string }[]> {
    const result = await this.runArgv([
      "/bin/bash",
      "-lc",
      'grep -rIn -- "$1" . 2>/dev/null | head -200',
      "search",
      pattern,
    ]);
    if (!result.stdout) return [];
    return result.stdout.split("\n").filter(Boolean).map((row) => {
      const first = row.indexOf(":");
      const second = row.indexOf(":", first + 1);
      if (first === -1) return { path: joinPath(dir, row), line: 0, content: "" };
      return {
        path: joinPath(dir, row.slice(0, first)),
        line: Number.parseInt(row.slice(first + 1, second === -1 ? undefined : second), 10) || 0,
        content: second === -1 ? row.slice(first + 1) : row.slice(second + 1),
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
    const branch = await this.runArgv(["/usr/bin/git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const status = await this.runArgv(["/usr/bin/git", "status", "--porcelain"], { cwd });
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
      branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
      staged,
      modified,
      untracked,
      raw: status.stdout ?? "",
    };
  }

  async getGitDiff(cwd: string): Promise<{ staged: string; unstaged: string }> {
    const [staged, unstaged] = await Promise.all([
      this.runArgv(["/usr/bin/git", "diff", "--cached"], { cwd }),
      this.runArgv(["/usr/bin/git", "diff"], { cwd }),
    ]);
    return { staged: staged.stdout, unstaged: unstaged.stdout };
  }

  private pidFile(port: number): string {
    return `/tmp/dai-dev-${port}.pid`;
  }

  /**
   * TCP readiness check. Modal's `Probe` only gates Sandbox creation, so an
   * already-running Sandbox is probed directly against the listening socket
   * rather than with a fixed sleep.
   */
  private async isPortListening(port: number): Promise<boolean> {
    const result = await this.runArgv(
      [
        "/bin/bash",
        "-c",
        'exec 3<>/dev/tcp/127.0.0.1/"$1" 2>/dev/null && exit 0 || exit 1',
        "probe",
        String(port),
      ],
      { timeoutMs: 5_000 }
    );
    return result.exitCode === 0;
  }

  async waitForPort(port: number, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let delay = 250;
    while (Date.now() < deadline) {
      if (await this.isPortListening(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, deadline - Date.now())));
      delay = Math.min(delay * 2, 2_000);
    }
    return (await this.isPortListening(port)) || false;
  }

  /**
   * Start the dev server as a session leader so it survives the exec that
   * launches it, and record its pid so a second call reuses a healthy server
   * instead of stacking a second listener on the same port.
   */
  async startDevServer(opts: { command: string; port: number; cwd?: string }): Promise<DevServerHandle> {
    const { port } = opts;
    const cwd = opts.cwd ?? WORKSPACE;

    if (await this.isPortListening(port)) {
      return { reused: true, port, ready: true };
    }

    // A stale pidfile whose process is gone is replaced, not honoured.
    const launched = await this.runArgv(
      [
        "/bin/bash",
        "-c",
        'setsid nohup sh -c "$1" > "$2" 2>&1 & echo $! > "$3"',
        "launch",
        opts.command,
        `/tmp/dai-dev-${port}.log`,
        this.pidFile(port),
      ],
      { cwd, timeoutMs: 15_000 }
    );
    if (launched.exitCode !== 0) {
      throw new RuntimeOperationError(
        `Failed to launch dev server: ${launched.stderr || launched.stdout}`,
        "rejected"
      );
    }

    const ready = await this.waitForPort(port, this.config.devServerReadyTimeoutMs);
    return { reused: false, port, ready };
  }

  async stopDevServer(port: number): Promise<void> {
    // Kill the recorded process group, then anything still bound to the port.
    await this.runArgv(
      [
        "/bin/bash",
        "-c",
        'if [ -f "$1" ]; then pgid=$(ps -o pgid= -p "$(cat "$1")" 2>/dev/null | tr -d " "); if [ -n "$pgid" ]; then kill -TERM -- "-$pgid" 2>/dev/null || true; fi; rm -f "$1"; fi',
        "stop",
        this.pidFile(port),
      ],
      { timeoutMs: 15_000 }
    );
  }

  /**
   * Authenticated HTTPS preview. `createConnectToken` is Modal's documented way
   * to obtain an HTTP entry point for a specific port; the returned token is
   * required, so the preview is not an open proxy.
   */
  async getPreviewUrl(port: number): Promise<PreviewTarget> {
    try {
      const credentials = await this.sandbox.createConnectToken({ port });
      return { url: credentials.url, token: credentials.token };
    } catch (error) {
      throw toRuntimeError(error, `Unable to create a preview tunnel for port ${port}`);
    }
  }

  async isAlive(): Promise<boolean> {
    try {
      return (await this.sandbox.poll()) === null;
    } catch (error) {
      if (isFailure(error, "unavailable")) return false;
      throw toRuntimeError(error, "Unable to determine Sandbox state");
    }
  }

  async terminate(): Promise<void> {
    try {
      await this.sandbox.terminate();
    } catch (error) {
      // Already finished is the desired end state, not a failure.
      if (isFailure(error, "unavailable")) return;
      throw toRuntimeError(error, "Unable to terminate Sandbox");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Local handles only: the Sandbox keeps running for the next request.
    try {
      this.sandbox.detach();
    } catch {
      // A detached or broken handle is already released.
    }
  }
}

export class ModalRuntimeService implements RuntimeService {
  readonly config: ModalRuntimeConfig;
  private readonly provider: ModalProvider;

  constructor(deps: { provider: ModalProvider }) {
    this.provider = deps.provider;
    this.config = deps.provider.config;
  }

  private probe(): ProbeType {
    // Gating creation on the workspace actually being mounted turns
    // `waitUntilReady` into a real readiness signal.
    return Probe.withExec(["/bin/sh", "-c", `test -d ${shellQuote(WORKSPACE)}`], { intervalMs: 500 });
  }

  /** Attach to a still-running Sandbox, or create one over the same Volume. */
  async acquire(options: AcquireOptions): Promise<Workspace> {
    const reattached = await this.tryReattach(options.existingSandboxId ?? null);
    if (reattached) return reattached;
    return this.create(options.projectId);
  }

  private async tryReattach(sandboxId: string | null): Promise<Workspace | null> {
    if (!sandboxId) return null;
    try {
      const sandbox = await this.provider.sandboxes.fromId(sandboxId);
      // A finished Sandbox cannot execute further commands, so only a live poll
      // of `null` justifies reuse.
      if ((await sandbox.poll()) !== null) {
        sandbox.detach();
        return null;
      }
      return new ModalWorkspace({ sandbox, config: this.config });
    } catch (error) {
      // Unknown or unreachable id: fall through to creation.
      if (isFailure(error, "unavailable", "not_found")) return null;
      throw error;
    }
  }

  async create(projectId: string): Promise<Workspace> {
    const [app, image, volume] = await Promise.all([
      this.provider.app(),
      this.provider.image(),
      this.provider.volume(),
    ]);

    const createParams = {
      cpu: this.config.cpu,
      memoryMiB: this.config.memoryMiB,
      timeoutMs: this.config.timeoutMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      workdir: this.config.workspacePath,
      volumes: { [this.config.workspacePath]: volume.withMountOptions({ subPath: volumeSubPath(projectId) }) },
      encryptedPorts: this.config.previewPorts,
      readinessProbe: this.probe(),
      name: sandboxName(projectId),
      tags: { "dai.project": projectId },
      ...(this.config.blockNetwork ? { blockNetwork: true } : {}),
      ...(this.config.outboundDomainAllowlist.length
        ? { outboundDomainAllowlist: this.config.outboundDomainAllowlist }
        : {}),
    };

    let sandbox: Sandbox;
    try {
      // No `command`: the Sandbox sleeps until timeout and is driven by exec(),
      // which is what lets one instance serve a whole agent run.
      sandbox = await this.provider.sandboxes.create(app, image, createParams);
    } catch (error) {
      // A name collision means another live Sandbox already owns this project;
      // find it and attach instead of failing the request.
      if (isFailure(error, "already_exists")) {
        const existing = await this.findByProject(projectId);
        if (existing) return existing;
      }
      throw toRuntimeError(error, "Unable to create a runtime Sandbox");
    }

    try {
      await sandbox.waitUntilReady(60_000);
    } catch (error) {
      // Ready-never-arrives leaves an unusable Sandbox; do not hand it out.
      try {
        await sandbox.terminate();
      } catch {
        // Best effort cleanup.
      }
      throw toRuntimeError(error, "Runtime Sandbox did not become ready");
    }

    return new ModalWorkspace({ sandbox, config: this.config });
  }

  /** Locate a live Sandbox for a project by tag, independent of stored ids. */
  async findByProject(projectId: string): Promise<Workspace | null> {
    try {
      for await (const sandbox of this.provider.sandboxes.list({ tags: { "dai.project": projectId } })) {
        if ((await sandbox.poll()) === null) {
          return new ModalWorkspace({ sandbox, config: this.config });
        }
        sandbox.detach();
      }
    } catch {
      // Listing is a recovery aid; its failure must not mask the original error.
    }
    return null;
  }

  /**
   * Make a project's durable workspace exist without keeping compute attached.
   *
   * The Volume itself is the durable object and is shared, so this only has to
   * confirm it resolves; mounting a subPath creates that directory. A real
   * Sandbox is therefore never provisioned just to "initialize" a project.
   */
  async ensureWorkspace(_projectId: string): Promise<void> {
    await this.provider.volume();
  }

  async status(projectId: string, sandboxId?: string | null): Promise<RuntimeState> {
    if (!sandboxId) return "provisioning";
    try {
      const sandbox = await this.provider.sandboxes.fromId(sandboxId);
      try {
        return (await sandbox.poll()) === null ? "running" : "stopped";
      } finally {
        sandbox.detach();
      }
    } catch (error) {
      if (isFailure(error, "unavailable", "not_found")) {
        // The stored id is stale; a tagged live Sandbox means we can still serve.
        const live = await this.findByProject(projectId);
        if (live) {
          live.close();
          return "running";
        }
        return "stopped";
      }
      return "unreachable";
    }
  }

  async destroy(projectId: string): Promise<void> {
    for await (const sandbox of this.provider.sandboxes.list({ tags: { "dai.project": projectId } })) {
      try {
        await sandbox.terminate();
      } catch {
        // Already terminated.
      }
    }
  }

  /**
   * Permanently delete a project's durable workspace.
   *
   * Modal's Volume exposes no file API, so removal runs in a short-lived Sandbox
   * that mounts the whole Volume. This is destructive and only called from the
   * project-delete path.
   */
  /**
   * Copy one project's durable workspace to another, server-side.
   *
   * Used by fork and by the CodeSandbox migration. Both subPaths live in the
   * same Volume, so a single Sandbox mounting the Volume root can `cp -a`
   * between them: one round trip, no per-file transfer, and no dependency on
   * either Sandbox being alive.
   */
  async duplicateWorkspace(sourceProjectId: string, targetProjectId: string): Promise<void> {
    const [app, image, volume] = await Promise.all([
      this.provider.app(),
      this.provider.image(),
      this.provider.volume(),
    ]);
    const sandbox = await this.provider.sandboxes.create(app, image, {
      cpu: 0.25,
      memoryMiB: 512,
      timeoutMs: ceilSecond(10 * 60_000),
      volumes: { [VOLUME_ROOT]: volume },
      tags: { "dai.project": targetProjectId, "dai.purpose": "duplicate" },
    });
    try {
      const source = volumeSubPath(sourceProjectId);
      const target = volumeSubPath(targetProjectId);
      const result = await sandbox.exec(
        ["/bin/bash", "-c", 'mkdir -p "$2" && cp -a "$1"/. "$2"/', "copy", source, target],
        { timeoutMs: 9 * 60_000 }
      );
      const exitCode = await result.wait();
      if (exitCode !== 0) {
        throw new RuntimeOperationError(`Unable to copy workspace ${sourceProjectId} to ${targetProjectId}`, "rejected");
      }
    } finally {
      try {
        await sandbox.terminate({ wait: true });
      } catch {
        // Already finished.
      }
    }
  }

  /**
   * Populate a project's workspace from a local tar archive.
   *
   * Used by the runtime migration to move code out of a previous provider. The
   * archive is uploaded in one `copyFromLocal` call and unpacked inside the
   * Sandbox, rather than one request per file.
   */
  async importWorkspaceArchive(projectId: string, localArchivePath: string): Promise<void> {
    const [app, image, volume] = await Promise.all([
      this.provider.app(),
      this.provider.image(),
      this.provider.volume(),
    ]);
    const sandbox = await this.provider.sandboxes.create(app, image, {
      cpu: 0.5,
      memoryMiB: 1_024,
      timeoutMs: ceilSecond(15 * 60_000),
      volumes: { [VOLUME_ROOT]: volume },
      tags: { "dai.project": projectId, "dai.purpose": "import" },
    });
    try {
      await sandbox.filesystem.copyFromLocal(localArchivePath, "/tmp/dai-import.tar.gz");
      const target = `${VOLUME_ROOT}/${volumeSubPath(projectId)}`;
      const proc = await sandbox.exec(
        ["/bin/bash", "-c", 'mkdir -p "$1" && tar -xzf /tmp/dai-import.tar.gz -C "$1"', "import", target],
        { timeoutMs: 14 * 60_000 }
      );
      const exitCode = await proc.wait();
      if (exitCode !== 0) {
        throw new RuntimeOperationError(
          `Unable to unpack archive into workspace for ${projectId}`,
          "rejected"
        );
      }
    } finally {
      try {
        await sandbox.terminate({ wait: true });
      } catch {
        // Already finished.
      }
    }
  }

  /** Release local gRPC/stream handles. Remote Sandboxes and the Volume persist. */
  close(): void {
    this.provider.close();
  }

  async purgeWorkspace(projectId: string): Promise<void> {
    const [app, image, volume] = await Promise.all([
      this.provider.app(),
      this.provider.image(),
      this.provider.volume(),
    ]);
    const sandbox = await this.provider.sandboxes.create(app, image, {
      cpu: 0.25,
      memoryMiB: 256,
      timeoutMs: ceilSecond(120_000),
      // The whole Volume, not the project subPath, so the directory itself goes.
      volumes: { [VOLUME_ROOT]: volume },
      tags: { "dai.project": projectId, "dai.purpose": "purge" },
    });
    try {
      await sandbox.exec(
        ["/bin/bash", "-c", 'rm -rf -- "$1"', "purge", volumeSubPath(projectId)],
        { timeoutMs: 60_000 }
      );
    } finally {
      try {
        await sandbox.terminate({ wait: true });
      } catch {
        // Terminating an already-finished Sandbox is a no-op.
      }
    }
  }
}
