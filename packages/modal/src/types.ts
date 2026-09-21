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

/** A live, attached runtime bound to one project's persistent workspace. */
export interface Workspace {
  readonly sandboxId: string;
  exec(command: string, opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
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
