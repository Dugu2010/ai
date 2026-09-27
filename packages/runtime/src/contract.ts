/**
 * Provider-neutral contract for DAI's remote execution runtime.
 *
 * The API layer (apps/api) depends only on these types, never on a provider SDK,
 * so the execution provider can be replaced without touching routes, tools or
 * the agent loop. Provider specifics live in that provider's own package.
 *
 * One asymmetry to keep in mind when implementing a provider: a method listed
 * here is not necessarily billed the same way as its neighbour. On both providers
 * DAI has used, executing a command costs metered CPU while a file operation may
 * cost only control-plane requests — and holding a machine awake costs wall
 * clock regardless of what it is doing. `runtime-policy.ts` is where that is
 * classified; implementations should note the cost of a method in their own
 * docs rather than let the contract imply uniformity.
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
  /**
   * A credential required to reach `url`, when the provider issues one.
   *
   * `null` means the URL is reachable by whoever holds it, which is a real
   * difference and not a formatting detail: callers must not treat a null token
   * as "the proxy will handle auth" when it means the preview is public.
   */
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
   * Read many files in one request.
   *
   * Used to capture undo pre-images. Providers whose file access is itself a
   * billed operation make this the difference between one charge and N; where
   * file reads are cheap it is still worth keeping batched because it bounds
   * how long the workspace stays attached. Values are the file's bytes decoded
   * as UTF-8 when it is text, and `null` when the path does not exist;
   * `isText` is false for content that will not round-trip.
   */
  readFilesBatch(paths: string[]): Promise<Record<string, BatchReadResult>>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Write or delete many files as one unit.
   *
   * Two properties matter here beyond throughput. Applying a 12-file edit one
   * call at a time can half-apply when the seventh fails, so the batch is the
   * unit of consistency; and each entry carries the content it expects to find
   * first, so a file somebody else changed is reported as a conflict rather than
   * silently clobbered. That compare-and-swap is what makes undo safe, and an
   * implementation may not drop it to save a round trip.
   *
   * Used both to apply agent edits and to undo them.
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
  /** Durable bytes under the mounted workspace. */
  workspaceUsageBytes(): Promise<number | null>;
  /** `false` once the provider reports the Sandbox has finished. */
  isAlive(): Promise<boolean>;
  terminate(): Promise<void>;
  /** Release the local handle without affecting the remote Sandbox. */
  close(): void;
}

/** Constructor arguments for a runtime bound to one project's workspace. */
export interface AcquireOptions {
  projectId: string;
  /** Reattach to or resume this sandbox first; created anew when absent or gone. */
  existingSandboxId?: string | null;
  /**
   * Index into the provider's configured resource tiers, smallest first.
   *
   * Choosing it is not this module's business — the caller escalates only after
   * an operation genuinely timed out. Out-of-range values clamp to the largest
   * tier the provider offers.
   */
  resourceTier?: number;
}

export interface RuntimeService {
  acquire(options: AcquireOptions): Promise<Workspace>;
  /** Provision the persistent workspace with no compute attached. */
  ensureWorkspace(projectId: string): Promise<void>;
  status(projectId: string, sandboxId?: string | null): Promise<RuntimeState>;
  /** Release live compute for a project, leaving its durable workspace intact. */
  destroy(projectId: string): Promise<void>;
  /** Server-side copy of one project's durable workspace into another's. */
  duplicateWorkspace(sourceProjectId: string, targetProjectId: string): Promise<void>;
  /** Permanently discard a project's durable workspace. Destructive. */
  purgeWorkspace(projectId: string): Promise<void>;
  /** Populate a project's workspace from a local tar archive. */
  importWorkspaceArchive(projectId: string, localArchivePath: string): Promise<void>;
  /** Release provider client resources held by the service itself. */
  close(): void;
}
