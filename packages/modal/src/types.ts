/**
 * Provider-neutral contract for DAI's remote execution runtime.
 *
 * The API layer (apps/api) depends only on these types, never on the Modal SDK,
 * so the execution provider can be replaced without touching routes, tools or
 * the agent loop. Modal specifics live in runtime.ts.
 */

export type RuntimeState =
  /** Sandbox exists and its VM is accepting commands. */
  | "running"
  /** No live Sandbox exists, but the persistent workspace is intact. */
  | "stopped"
  /** Workspace is being created for the first time. */
  | "provisioning"
  /** The provider could not be reached or the handle is unusable. */
  | "unreachable";

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
  /** Authenticated connect token, when the provider issues one. */
  token: string | null;
}

export interface DevServerHandle {
  reused: boolean;
  port: number;
  ready: boolean;
}

export type BatchReadResult =
  | { exists: false }
  | { exists: true; isText: boolean; size: number; content: string | null; binary: string | null }
  | { error: string };

/** Outcome of applying one recorded path change. */
export interface MutationResult {
  path: string;
  status: "restored" | "deleted" | "conflict" | "error" | "skipped";
  detail?: string;
}

/**
 * One file to write or delete. `content: null` deletes the path. `expectCurrent`
 * is the exact text the file must hold for the mutation to be allowed.
 */
export interface FileMutation {
  path: string;
  content: string | null;
  expectCurrent: string | null;
}

/** A live, attached runtime bound to one project's persistent workspace. */
export interface Workspace {
  readonly sandboxId: string;
  exec(command: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
  readFile(path: string): Promise<string | null>;
  /**
   * Read many files in ONE batched request.
   *
   * Used to capture undo pre-images. Reading a pending path one at a time would
   * cost a Sandbox command each, so the whole set is fetched together. Values are
   * the file's bytes decoded as UTF-8 when it is text, and `null` when the path
   * does not exist; `isText` is false for content that will not round-trip.
   */
  readFilesBatch(paths: string[]): Promise<Record<string, BatchReadResult>>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Write or delete many files in ONE batched command.
   *
   * This is the main cost lever on this provider: each individual filesystem
   * call is itself a command inside the Sandbox, so applying a 12-file edit
   * one-by-one spends 12 runtime commands and can half-apply when the seventh
   * fails. As one request it costs one.
   *
   * Each entry carries the content it expects to find first, so a file someone
   * else changed is reported as a conflict rather than silently clobbered. Used
   * both to apply agent edits and to undo them.
   */
  applyFileMutations(entries: FileMutation[], opts?: { timeoutMs?: number }): Promise<MutationResult[]>;
  listFiles(path: string): Promise<FileEntry[]>;
  stat(path: string): Promise<{ size: number; isDirectory: boolean } | null>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  searchFiles(dir: string, pattern: string): Promise<string[]>;
  searchContent(dir: string, pattern: string): Promise<{ path: string; line: number; content: string }[]>;
  getGitStatus(cwd: string): Promise<{
    branch: string | null;
    staged: string[];
    modified: string[];
    untracked: string[];
    raw: string;
  }>;
  getGitDiff(cwd: string): Promise<{ staged: string; unstaged: string }>;
  waitForPort(port: number, timeoutMs?: number): Promise<boolean>;
  startDevServer(opts: { command: string; port: number; cwd?: string }): Promise<DevServerHandle>;
  stopDevServer(port: number): Promise<void>;
  getPreviewUrl(port: number): Promise<PreviewTarget>;
  /** Durable bytes under the mounted workspace, measured on the live Sandbox. */
  workspaceUsageBytes(): Promise<number | null>;
  /** `false` once the provider reports the Sandbox has finished. */
  isAlive(): Promise<boolean>;
  terminate(): Promise<void>;
  /** Release the local handle without affecting the remote Sandbox. */
  close(): void;
}

/** Constructor arguments for a fresh Sandbox over an existing workspace. */
export interface AcquireOptions {
  projectId: string;
  /** Reattach to this Sandbox first; created anew when absent or finished. */
  existingSandboxId?: string | null;
}

export interface RuntimeService {
  acquire(options: AcquireOptions): Promise<Workspace>;
  /** Provision the persistent workspace with no compute attached. */
  ensureWorkspace(projectId: string): Promise<void>;
  status(projectId: string, sandboxId?: string | null): Promise<RuntimeState>;
  destroy(projectId: string): Promise<void>;
}
