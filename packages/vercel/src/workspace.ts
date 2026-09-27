/**
 * Vercel implementation of the `Workspace` half of DAI's runtime contract.
 *
 * Cost honesty matters more here than anywhere else in this file. On this
 * provider the operations split three ways, and the split is not visible in the
 * SDK's own naming:
 *
 *   - `runCommand` executes a real process and is metered as Active CPU.
 *   - `fs.readdir`, `fs.stat`, `fs.rename`, `fs.rm` and `fs.mkdir` are all
 *     implemented *inside the SDK* by running `find`, `stat`, `mv`, `rm` and
 *     `mkdir` as commands, so they are Active CPU too despite looking like
 *     filesystem metadata calls.
 *   - `readFileToBuffer` and `writeFiles` are genuine file transfers: no command,
 *     no Active CPU — but still `withResume`, so they wake the VM and bill its
 *     wall clock against provisioned memory.
 *
 * Nothing here may pretend a cold project can be inspected without paying. The
 * mirror in `mirror.ts` is what answers cold reads; this class only ever touches
 * a live sandbox, and it reports to the mirror whenever a command could have
 * written files the mirror never saw.
 */

import type { Command, CommandFinished, Sandbox } from "@vercel/sandbox";
import { toRuntimeError } from "@dai/runtime";
import type {
  BatchReadResult,
  DevServerHandle,
  ExecResult,
  FileEntry,
  FileMutation,
  MutationResult,
  PreviewTarget,
  Workspace,
} from "@dai/runtime";
import type { WorkspaceMirror } from "./mirror.js";

/** How long a killed command's stream may take to report back after its deadline. */
const TIMEOUT_GRACE_MS = 250;

/** Cap on a name or content search, shared by both implementations. */
const SEARCH_LIMIT = 200;

export interface VercelWorkspaceDeps {
  sandbox: Sandbox;
  projectId: string;
  workspacePath: string;
  execTimeoutMs: number;
  devServerReadyTimeoutMs: number;
  /**
   * Present when an R2 mirror is configured. Every command marks the project
   * dirty through this, because a process can create files no one told us about.
   */
  mirror?: Pick<WorkspaceMirror, "markDirty">;
}

export class VercelWorkspace implements Workspace {
  private readonly sandbox: Sandbox;
  private readonly projectId: string;
  private readonly workspacePath: string;
  private readonly execTimeoutMs: number;
  private readonly devServerReadyTimeoutMs: number;
  private readonly mirror?: VercelWorkspaceDeps["mirror"];
  /** Detached processes we launched, keyed by port, so a stop can find them. */
  private readonly devServerCommands = new Map<number, Command>();
  private released = false;

  constructor(deps: VercelWorkspaceDeps) {
    this.sandbox = deps.sandbox;
    this.projectId = deps.projectId;
    this.workspacePath = deps.workspacePath;
    this.execTimeoutMs = deps.execTimeoutMs;
    this.devServerReadyTimeoutMs = deps.devServerReadyTimeoutMs;
    this.mirror = deps.mirror;
  }

  get sandboxId(): string {
    return this.sandbox.name;
  }

  /** Provider handle, for the service layer that still needs the raw sandbox. */
  get raw(): Sandbox {
    return this.sandbox;
  }

  get status(): string {
    return this.sandbox.status;
  }

  /**
   * Cumulative Active CPU for this sandbox, in ms.
   *
   * Read from the SDK rather than estimated locally: the platform's own counter
   * excludes I/O wait, which is exactly the quantity the monthly budget is
   * measured in, and a wall-clock estimate here would over-count by design.
   */
  get activeCpuUsageMs(): number {
    return this.sandbox.activeCpuUsageMs ?? 0;
  }

  /** Run a program by argv. Never builds a shell string, so paths cannot inject. */
  private async run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
  ): Promise<CommandFinished> {
    try {
      return await this.sandbox.runCommand({
        cmd,
        args,
        cwd: opts.cwd ?? this.workspacePath,
        timeoutMs: opts.timeoutMs ?? this.execTimeoutMs,
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch (error) {
      throw toRuntimeError(error, `Command failed: ${cmd}`);
    }
  }

  /** A command ran, so whatever the mirror holds about this project is suspect. */
  private notePossibleWrite(): void {
    void this.mirror?.markDirty(this.projectId).catch(() => undefined);
  }

  async exec(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<ExecResult> {
    const startedAt = Date.now();
    const timeoutMs = opts?.timeoutMs ?? this.execTimeoutMs;
    // The agent's command contract is a shell string (`npm i && npm t`), so this
    // is the one place a shell is genuinely required. It runs inside this
    // project's own sandbox, never on the API host.
    const finished = await this.run("/bin/bash", ["-lc", command], { ...opts, timeoutMs });
    const durationMs = Date.now() - startedAt;
    const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
    this.notePossibleWrite();
    return {
      stdout: stdout || null,
      stderr: stderr || null,
      exitCode: finished.exitCode,
      durationMs,
      // The SDK reports a killed command as a completed one with a non-zero code
      // and no deadline field, so a command that ran to the time it was given and
      // failed is reported as a timeout. The grace is only for stream lag; a wider
      // allowance would relabel ordinary failures as timeouts and send the loop
      // escalating a machine that was never the problem.
      timedOut: finished.exitCode !== 0 && durationMs >= timeoutMs - TIMEOUT_GRACE_MS,
    };
  }

  /** File transfer, not a command: no Active CPU, but it does wake the VM. */
  async readFile(path: string): Promise<string | null> {
    try {
      const bytes = await this.sandbox.readFileToBuffer({ path });
      return bytes === null ? null : bytes.toString("utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw toRuntimeError(error, `Unable to read ${path}`);
    }
  }

  async readFilesBatch(paths: string[]): Promise<Record<string, BatchReadResult>> {
    const outcomes: Record<string, BatchReadResult> = {};
    // Sequential on purpose: the transfers are cheap but each one resumes work on
    // a single VM, and a burst of parallel requests against the same sandbox is
    // how a batch ends up half-failed under load.
    for (const path of paths) {
      try {
        const bytes = await this.sandbox.readFileToBuffer({ path });
        if (bytes === null) {
          outcomes[path] = { exists: false };
          continue;
        }
        const text = bytes.toString("utf8");
        // Round-trip check, not a heuristic: if re-encoding the decoded text does
        // not reproduce the bytes, undo could not restore this file faithfully.
        const isText = Buffer.from(text, "utf8").equals(bytes);
        outcomes[path] = {
          exists: true,
          isText,
          size: bytes.length,
          content: isText ? text : null,
          binary: isText ? null : bytes.toString("base64"),
        };
      } catch (error) {
        outcomes[path] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return outcomes;
  }

  async writeFile(path: string, content: string): Promise<void> {
    try {
      await this.sandbox.writeFiles([{ path, content }]);
      return;
    } catch (error) {
      if (!isNotFound(error) && !isMissingDirectory(error)) throw toRuntimeError(error, `Unable to write ${path}`);
    }
    // Parents are not implicit; create them and retry once, mirroring the
    // behaviour every other provider in this repo has had to add.
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    try {
      await this.sandbox.fs.mkdir(parent, { recursive: true });
      await this.sandbox.writeFiles([{ path, content }]);
    } catch (error) {
      throw toRuntimeError(error, `Unable to write ${path}`);
    }
  }

  /**
   * Apply a batch of writes and deletes, honouring each entry's `expectCurrent`.
   *
   * The SDK has no compare-and-swap, so it is done here: reads are free of
   * Active CPU, so verifying before writing costs nothing the batch was not
   * already paying for. The virtual current state is threaded through the batch
   * in entry order, which is what lets two edits to one file in a single turn
   * both land instead of the second silently conflicting.
   */
  async applyFileMutations(
    entries: FileMutation[],
    opts?: { timeoutMs?: number }
  ): Promise<MutationResult[]> {
    if (entries.length === 0) return [];

    const virtual = new Map<string, string | null>();
    const readCurrent = async (path: string): Promise<string | null> => {
      if (virtual.has(path)) return virtual.get(path) ?? null;
      const bytes = await this.sandbox.readFileToBuffer({ path });
      const text = bytes === null ? null : bytes.toString("utf8");
      virtual.set(path, text);
      return text;
    };

    const writes: { path: string; content: string }[] = [];
    const deletes: string[] = [];
    const checked: MutationResult[] = [];

    for (const entry of entries) {
      let current: string | null;
      try {
        current = await readCurrent(entry.path);
      } catch (error) {
        checked.push({ path: entry.path, status: "error", detail: toRuntimeError(error, "read failed").message });
        continue;
      }

      if (entry.expectCurrent === null) {
        if (current !== null) {
          checked.push({
            path: entry.path,
            status: "conflict",
            detail: "file exists but the checkpoint recorded it as absent",
          });
          continue;
        }
      } else if (current === null) {
        checked.push({ path: entry.path, status: "conflict", detail: "file no longer exists" });
        continue;
      } else if (current !== entry.expectCurrent) {
        checked.push({ path: entry.path, status: "conflict", detail: "content changed since the checkpoint" });
        continue;
      }

      if (entry.content === null) {
        deletes.push(entry.path);
      } else {
        writes.push({ path: entry.path, content: entry.content });
      }
      virtual.set(entry.path, entry.content);
      checked.push({ path: entry.path, status: entry.content === null ? "deleted" : "restored" });
    }

    if (writes.length > 0) {
      try {
        await this.sandbox.writeFiles(writes);
      } catch (error) {
        const message = toRuntimeError(error, "batched write failed").message;
        return checked.map((result) =>
          result.status === "restored" ? { path: result.path, status: "error", detail: message } : result
        );
      }
    }
    // Deletion is a command (`rm`), so it costs Active CPU. Grouped into one call
    // so a checkpoint undoing twelve created files is twelve removes' worth of
    // argument, not twelve separate processes.
    if (deletes.length > 0) {
      try {
        await this.run("/bin/rm", ["-rf", "--", ...deletes], { timeoutMs: opts?.timeoutMs });
      } catch (error) {
        const message = toRuntimeError(error, "batched delete failed").message;
        for (const result of checked) {
          if (result.status === "deleted" && deletes.includes(result.path)) {
            result.status = "error";
            result.detail = message;
          }
        }
      }
    }
    this.notePossibleWrite();
    return checked;
  }

  /** Listing is a `find`/`ls` command inside the SDK, so it costs Active CPU. */
  async listFiles(path: string): Promise<FileEntry[]> {
    try {
      const entries = await this.sandbox.fs.readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        path: joinWorkspace(path, entry.name, this.workspacePath),
        kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        size: null,
      }));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw toRuntimeError(error, `Unable to list ${path}`);
    }
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean } | null> {
    try {
      const info = await this.sandbox.fs.stat(path);
      return { size: info.size, isDirectory: info.isDirectory() };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw toRuntimeError(error, `Unable to stat ${path}`);
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.sandbox.fs.rm(path, { recursive: true, force: true });
      this.notePossibleWrite();
    } catch (error) {
      throw toRuntimeError(error, `Unable to remove ${path}`);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await this.sandbox.fs.rename(from, to);
      this.notePossibleWrite();
    } catch (error) {
      throw toRuntimeError(error, `Unable to move ${from} to ${to}`);
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.sandbox.fs.mkdir(path, { recursive: true });
      this.notePossibleWrite();
    } catch (error) {
      if (isAlreadyExists(error) || isPermissionDenied(error)) return;
      throw toRuntimeError(error, `Unable to create directory ${path}`);
    }
  }

  /**
   * Find files by name.
   *
   * One `find` rather than a walk of `fs.readdir`, because readdir is itself
   * implemented as a `find` command inside the SDK: walking the tree that way
   * would pay one command per directory for the same answer.
   */
  async searchFiles(dir: string, pattern: string): Promise<string[]> {
    const result = await this.run(
      "/usr/bin/find",
      [dir, "-maxdepth", "12", "-type", "f", "-name", pattern],
      { timeoutMs: this.execTimeoutMs }
    );
    const stdout = await result.stdout();
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, SEARCH_LIMIT);
  }

  async searchContent(dir: string, pattern: string): Promise<{ path: string; line: number; content: string }[]> {
    const result = await this.run("/bin/grep", ["-rIn", "--", pattern, dir], { timeoutMs: this.execTimeoutMs });
    const stdout = await result.stdout();
    return stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 200)
      .map((row) => {
        const first = row.indexOf(":");
        const second = row.indexOf(":", first + 1);
        if (first === -1) return { path: row, line: 0, content: "" };
        return {
          path: row.slice(0, first),
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
    const branch = await this.run("/usr/bin/git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const status = await this.run("/usr/bin/git", ["status", "--porcelain"], { cwd });
    const branchOut = (await branch.stdout()).trim();
    const raw = await status.stdout();
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.length < 4) continue;
      const state = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (!file) continue;
      if (state === "??") untracked.push(file);
      else if (state[0] !== " " && state[0] !== "?") staged.push(file);
      else if (state[1] !== " " && state[1] !== "?") modified.push(file);
    }
    return {
      branch: branch.exitCode === 0 ? branchOut || null : null,
      staged,
      modified,
      untracked,
      raw,
    };
  }

  async getGitDiff(cwd: string): Promise<{ staged: string; unstaged: string }> {
    const [staged, unstaged] = await Promise.all([
      this.run("/usr/bin/git", ["diff", "--cached"], { cwd }),
      this.run("/usr/bin/git", ["diff"], { cwd }),
    ]);
    return { staged: await staged.stdout(), unstaged: await unstaged.stdout() };
  }

  /**
   * TCP readiness. The SDK exposes no socket probe, so this is a shell test
   * against loopback: a command, therefore metered, which is why callers poll it
   * on a backoff instead of in a tight loop.
   */
  async isPortListening(port: number): Promise<boolean> {
    const result = await this.run(
      "/bin/bash",
      ["-c", 'exec 3<>/dev/tcp/127.0.0.1/"$1" 2>/dev/null && exit 0 || exit 1', "probe", String(port)],
      { timeoutMs: 5_000 }
    );
    return result.exitCode === 0;
  }

  async waitForPort(port: number, timeoutMs = this.devServerReadyTimeoutMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let delay = 250;
    while (Date.now() < deadline) {
      if (await this.isPortListening(port)) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      delay = Math.min(delay * 2, 2_000);
    }
    return await this.isPortListening(port);
  }

  /**
   * Start the dev server as a detached process and remember its handle.
   *
   * Vercel has real detached execution, so the `setsid nohup` wrapper and its
   * pid-file indirection are gone: `kill()` on the returned command stops exactly
   * the process that was started.
   */
  async startDevServer(opts: { command: string; port: number; cwd?: string }): Promise<DevServerHandle> {
    const { port } = opts;
    if (await this.isPortListening(port)) return { reused: true, port, ready: true };

    const launched = await this.sandbox
      .runCommand({
        cmd: "/bin/sh",
        args: ["-c", opts.command],
        cwd: opts.cwd ?? this.workspacePath,
        detached: true,
      })
      .catch((error: unknown) => {
        throw toRuntimeError(error, "Failed to launch dev server");
      });

    this.devServerCommands.set(port, launched);
    this.notePossibleWrite();
    const ready = await this.waitForPort(port);
    return { reused: false, port, ready };
  }

  async stopDevServer(port: number): Promise<void> {
    const command = this.devServerCommands.get(port);
    if (command) {
      try {
        await command.kill();
      } catch {
        // Already gone; the fallback below still runs.
      }
      this.devServerCommands.delete(port);
    }
    // A handle from a previous API process is not recoverable, so sweep by port
    // as well. This is a command and therefore metered; it runs on an explicit
    // user action, never on a timer.
    const listener = await this.isPortListening(port);
    if (listener) {
      await this.run("/bin/bash", ["-c", 'fuser -k "$1"/tcp 2>/dev/null || true', "stop", String(port)], {
        timeoutMs: 15_000,
      });
    }
  }

  /**
   * The public host for an exposed port.
   *
   * `token` is always null here, and that is a real difference from the previous
   * provider rather than an absent optional: these URLs are reachable by anyone
   * who has them for as long as the sandbox lives, so the API layer must not hand
   * one to the browser directly.
   */
  async getPreviewUrl(port: number): Promise<PreviewTarget> {
    try {
      return { url: this.sandbox.domain(port), token: null };
    } catch {
      return { url: null, token: null };
    }
  }

  /**
   * Durable bytes under the mounted workspace.
   *
   * `du` is a command, so this is metered; it is only used when the mirror cannot
   * answer, which is exactly the case where an estimate would be a lie.
   */
  async workspaceUsageBytes(): Promise<number | null> {
    const proc = await this.run("/bin/bash", ["-c", 'du -sb -- "$1" 2>/dev/null | cut -f1', "du", this.workspacePath], {
      timeoutMs: 30_000,
    });
    if (proc.exitCode !== 0) return null;
    const bytes = Number.parseInt((await proc.stdout()).trim(), 10);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  }

  async isAlive(): Promise<boolean> {
    try {
      return this.sandbox.status === "running";
    } catch {
      return false;
    }
  }

  /** Stop the session, which snapshots the filesystem. The workspace persists. */
  async terminate(): Promise<void> {
    try {
      await this.sandbox.stop();
    } catch (error) {
      // Already stopped is the desired end state, not a failure.
      if (!isNotFound(error) && !isGone(error)) throw toRuntimeError(error, "Unable to stop Sandbox");
    }
  }

  /**
   * Drop the local handle only.
   *
   * There is nothing to detach on this provider — the object is a client over
   * HTTP — but the contract requires the call, and the caller's intent (leave the
   * sandbox running for the next request) is what the flag records.
   */
  close(): void {
    this.released = true;
  }

  get isReleased(): boolean {
    return this.released;
  }
}

function joinWorkspace(dir: string, name: string, workspaceRoot: string): string {
  if (dir === workspaceRoot || dir === "/" || dir === "") return `${dir === "/" ? "" : dir}/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function codeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  return [candidate.code, candidate.name, candidate.message].filter((part) => typeof part === "string").join(" ").toLowerCase();
}

function isNotFound(error: unknown): boolean {
  const code = codeOf(error);
  return code.includes("404") || code.includes("not_found") || code.includes("notfound") || code.includes("enoent");
}

function isMissingDirectory(error: unknown): boolean {
  return codeOf(error).includes("enotdir");
}

function isAlreadyExists(error: unknown): boolean {
  const code = codeOf(error);
  return code.includes("409") || code.includes("eexist");
}

function isPermissionDenied(error: unknown): boolean {
  return codeOf(error).includes("eacces");
}

function isGone(error: unknown): boolean {
  const code = codeOf(error);
  return code.includes("stopped") || code.includes("terminated") || code.includes("expired");
}
