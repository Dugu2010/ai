/**
 * In-memory stand-ins for the two SDKs `@dai/vercel` talks to.
 *
 * The Sandbox fake is deliberately narrow: it implements only what the provider
 * calls, and it records every command so a test can assert what was metered.
 * The object-store fake backs the mirror, which is the part with real logic in
 * it — key layout, dirty tracking and one-level listing derived from key shapes.
 */

import type { ObjectStore, StoredObject } from "../src/object-store.js";

export interface FakeCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface ExecCall {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  detached?: boolean;
}

interface CommandHandler {
  match: (argv: string[]) => boolean;
  result: FakeCommandResult | ((argv: string[]) => FakeCommandResult);
  /** Wall time this fake command appears to consume, for deadline behaviour. */
  delayMs?: number;
}

export interface FakeSandboxOptions {
  name?: string;
  status?: string;
  files?: Record<string, string>;
  /** Raw bytes, for the round-trip test that decides whether undo can restore a file. */
  binary?: Record<string, Uint8Array>;
  directories?: string[];
  handlers?: CommandHandler[];
  /** Active CPU the platform reports for this sandbox, in ms. */
  activeCpuMs?: number;
  /** Thrown by `stop()`, to exercise the already-gone path. */
  stopError?: Error;
  domainError?: boolean;
}

class FakeCommand {
  constructor(
    private readonly sandbox: FakeSandbox,
    private readonly result: FakeCommandResult,
    readonly detached: boolean
  ) {}

  get exitCode(): number {
    return this.result.exitCode;
  }

  async stdout(): Promise<string> {
    return this.result.stdout ?? "";
  }

  async stderr(): Promise<string> {
    return this.result.stderr ?? "";
  }

  async wait(): Promise<FakeCommand> {
    return this;
  }

  async kill(): Promise<void> {
    this.sandbox.killed += 1;
  }
}

export class FakeSandbox {
  readonly name: string;
  status: string;
  readonly calls: { exec: ExecCall[]; reads: string[]; writes: string[][]; stopped: number; killed: number } = {
    exec: [],
    reads: [],
    writes: [],
    stopped: 0,
    killed: 0,
  };
  get killed(): number {
    return this.calls.killed;
  }
  set killed(value: number) {
    this.calls.killed = value;
  }

  private readonly files: Map<string, string | Uint8Array>;
  private readonly directories: Set<string>;
  private readonly handlers: CommandHandler[];
  private readonly activeCpuMs: number;
  private readonly stopError?: Error;
  private readonly domainError: boolean;

  constructor(options: FakeSandboxOptions = {}) {
    this.name = options.name ?? "dai-test";
    this.status = options.status ?? "running";
    this.files = new Map<string, string | Uint8Array>(Object.entries(options.files ?? {}));
    for (const [path, bytes] of Object.entries(options.binary ?? {})) this.files.set(path, bytes);
    this.directories = new Set(options.directories ?? ["/workspace"]);
    this.handlers = options.handlers ?? [];
    this.activeCpuMs = options.activeCpuMs ?? 0;
    this.stopError = options.stopError;
    this.domainError = options.domainError ?? false;
  }

  get activeCpuUsageMs(): number {
    return this.activeCpuMs;
  }

  /** Everything a test asked to script, flattened into argv. */
  runCommand(params: { cmd: string; args?: string[]; cwd?: string; detached?: boolean; timeoutMs?: number }): Promise<FakeCommand>;
  runCommand(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<FakeCommand>;
  async runCommand(
    first: { cmd: string; args?: string[]; cwd?: string; detached?: boolean; timeoutMs?: number } | string,
    args?: string[],
    opts?: { timeoutMs?: number }
  ): Promise<FakeCommand> {
    const params = typeof first === "string" ? { cmd: first, args, ...opts } : first;
    const argv = [params.cmd, ...(params.args ?? [])];
    this.calls.exec.push({
      argv,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
      detached: params.detached,
    });
    if (params.cmd.endsWith("/rm")) {
      for (const target of params.args ?? []) {
        if (target.startsWith("-")) continue;
        for (const key of [...this.files.keys()]) {
          if (key === target || key.startsWith(`${target}/`)) this.files.delete(key);
        }
      }
    }
    const scripted = this.handlers.find((handler) => handler.match(argv));
    if (scripted?.delayMs) await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
    const outcome = scripted
      ? typeof scripted.result === "function"
        ? scripted.result(argv)
        : scripted.result
      : { exitCode: 0 };
    return new FakeCommand(this, outcome, Boolean(params.detached));
  }

  async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
    this.calls.reads.push(file.path);
    const content = this.files.get(file.path);
    if (content === undefined) return null;
    // Returned verbatim: a file whose bytes are not valid UTF-8 must not be
    // repaired on the way out, or the provider's text/binary detection has
    // nothing left to find.
    return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  }

  async writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<void> {
    this.calls.writes.push(files.map((file) => file.path));
    for (const file of files) {
      this.files.set(file.path, typeof file.content === "string" ? file.content : Uint8Array.from(file.content));
    }
  }

  domain(port: number): string {
    if (this.domainError) throw new Error("no route for port");
    return `https://${this.name}-${port}.vercel.run`;
  }

  async stop(): Promise<{ snapshot?: { id: string } }> {
    this.calls.stopped += 1;
    if (this.stopError) throw this.stopError;
    this.status = "stopped";
    return { snapshot: { id: `snap-${this.name}` } };
  }

  /** Direct mutation for assertions and test setup. */
  seed(path: string, content: string | null): void {
    if (content === null) this.files.delete(path);
    else this.files.set(path, content);
  }

  contentOf(path: string): string | undefined {
    const content = this.files.get(path);
    return content === undefined ? undefined : typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  }

  hasDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  readonly fs = {
    readdir: async (path: string, options?: { withFileTypes?: boolean }) => {
      this.calls.exec.push({ argv: [path, "ls"] });
      const prefix = `${path.replace(/\/+$/, "")}/`;
      const names = new Set<string>();
      const entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[] = [];
      for (const key of this.files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest || names.has(rest.split("/")[0] as string)) continue;
        const name = rest.split("/")[0] as string;
        names.add(name);
        const isDir = rest.includes("/");
        entries.push({ name, isDirectory: () => isDir, isSymbolicLink: () => false });
      }
      for (const dir of this.directories) {
        if (!dir.startsWith(prefix)) continue;
        const name = dir.slice(prefix.length);
        if (!name || name.includes("/") || names.has(name)) continue;
        names.add(name);
        entries.push({ name, isDirectory: () => true, isSymbolicLink: () => false });
      }
      if (options?.withFileTypes) return entries;
      return [...names];
    },
    stat: async (path: string) => {
      this.calls.exec.push({ argv: [path, "stat"] });
      const content = this.files.get(path);
      if (content !== undefined) {
        return { size: Buffer.byteLength(content, "utf8"), isDirectory: () => false };
      }
      if (this.directories.has(path)) return { size: 0, isDirectory: () => true };
      throw apiError(404, `not found: ${path}`);
    },
    rm: async (path: string) => {
      this.calls.exec.push({ argv: ["rm", "-rf", path] });
      for (const key of [...this.files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
      }
      this.directories.delete(path);
    },
    rename: async (from: string, to: string) => {
      this.calls.exec.push({ argv: ["mv", from, to] });
      const moved: [string, string][] = [];
      for (const key of [...this.files.keys()]) {
        if (key === from) moved.push([key, to]);
        else if (key.startsWith(`${from}/`)) moved.push([key, `${to}${key.slice(from.length)}`]);
      }
      if (moved.length === 0 && !this.files.has(from)) throw apiError(404, `not found: ${from}`);
      for (const [source, target] of moved) {
        const content = this.files.get(source) as string;
        this.files.delete(source);
        this.files.set(target, content);
      }
    },
    mkdir: async (path: string) => {
      this.calls.exec.push({ argv: ["mkdir", "-p", path] });
      if (this.files.has(path)) throw apiError(409, "already exists");
      this.directories.add(path);
    },
  };
}

/** An error shaped like the SDK's `APIError`, which carries the Response. */
export function apiError(status: number, message: string): Error {
  const error = new Error(message) as Error & { response?: { status: number } };
  error.response = { status };
  return error;
}

export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly ops: string[] = [];
  copies = 0;

  async put(key: string, body: string | Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    this.ops.push(`put:${key}`);
    this.objects.set(key, {
      body: typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body),
      contentType,
    });
  }

  async get(key: string): Promise<Buffer | null> {
    this.ops.push(`get:${key}`);
    return this.objects.get(key)?.body ?? null;
  }

  async head(key: string): Promise<{ size: number } | null> {
    const entry = this.objects.get(key);
    return entry ? { size: entry.body.length } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const found: StoredObject[] = [];
    for (const [key, entry] of this.objects) {
      if (key.startsWith(prefix)) found.push({ key, size: entry.body.length });
    }
    return found.sort((a, b) => a.key.localeCompare(b.key));
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    this.copies += 1;
    const entry = this.objects.get(sourceKey);
    if (entry) this.objects.set(targetKey, { ...entry });
  }

  text(key: string): string | null {
    return this.objects.get(key)?.body.toString("utf8") ?? null;
  }
}

export const testConfig = () => ({
  namePrefix: "dai",
  drivePrefix: "dai-workspace",
  image: "vercel/sandbox/node:22",
  region: "iad1",
  workspacePath: "/workspace",
  sessionTimeoutMs: 15 * 60_000,
  execTimeoutMs: 120_000,
  devServerReadyTimeoutMs: 2_000,
  previewPorts: [3000],
  tiers: [
    { vcpus: 1, label: "small" as const },
    { vcpus: 2, label: "medium" as const },
    { vcpus: 4, label: "large" as const },
  ],
  cacheDriveName: "",
  cachePath: "/dai-cache",
  cacheEnv: {
    npm_config_cache: "/dai-cache/npm",
    YARN_CACHE_FOLDER: "/dai-cache/yarn",
    PNPM_HOME: "/dai-cache/pnpm",
    PIP_CACHE_DIR: "/dai-cache/pip",
    GOMODCACHE: "/dai-cache/go/pkg/mod",
    GOCACHE: "/dai-cache/go/build",
  },
  keepLastSnapshots: 1,
  snapshotExpirationMs: 7 * 24 * 3600_000,
  maxProjectWorkspaceBytes: 50 * 1024 * 1024 * 1024,
  r2: { accountId: "acct", bucket: "dai", accessKeyId: "key", secretAccessKey: "secret", rootPrefix: "workspaces" },
  budget: {
    activeCpuMs: 5 * 3600_000,
    provisionedGbHours: 420,
    creations: 5000,
    egressBytes: 20 * 1024 * 1024 * 1024,
    haltFraction: 0.95,
    throttleFraction: 0.8,
    warnFraction: 0.6,
  },
});

/** The mirror slice a VercelWorkspace needs, so tests can watch dirty tracking. */
export class RecordingMirror {
  dirtyCalls: string[] = [];
  async markDirty(projectId: string): Promise<void> {
    this.dirtyCalls.push(projectId);
  }
}
