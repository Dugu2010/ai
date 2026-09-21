const WORKSPACE_ROOT = "/workspace";

/**
 * In-memory stand-ins for the Modal gRPC client.
 *
 * These exist so the runtime's control logic is genuinely tested without
 * credentials. They assert on what the code sent to the SDK, which is exactly
 * the part that can silently regress. None of this talks to Modal.
 */

import { AlreadyExistsError, NotFoundError, SandboxFilesystemNotFoundError, SandboxTimeoutError } from "modal";
import type { ModalRuntimeConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/config.js";

export interface ExecCall {
  argv: string[];
  params?: Record<string, unknown>;
}

export interface FakeSandboxOptions {
  id: string;
  /** Value returned by poll(): null means "still running". */
  pollResult?: number | null;
  files?: Record<string, string>;
  /** Programmed replies for exec(), consumed in order by argv match. */
  execHandlers?: Array<{ match: string; stdout?: string; stderr?: string; exitCode?: number; throws?: Error }>;
  waitUntilReadyThrows?: Error;
  createTokenResult?: { url: string; token: string };
}

export class FakeSandbox {
  readonly sandboxId: string;
  readonly calls: { exec: ExecCall[]; terminated: number; detached: number; tunnels: number; tokens: ExecCall[] } = {
    exec: [],
    terminated: 0,
    detached: 0,
    tunnels: 0,
    tokens: [],
  };
  pollResult: number | null;
  waitUntilReadyThrows?: Error;
  files: Record<string, string>;
  private dirs = new Set<string>();
  execHandlers: FakeSandboxOptions["execHandlers"];
  createTokenResult: { url: string; token: string };

  constructor(options: FakeSandboxOptions) {
    this.sandboxId = options.id;
    this.pollResult = options.pollResult ?? null;
    this.files = { ...(options.files ?? {}) };
    this.execHandlers = options.execHandlers ?? [];
    this.waitUntilReadyThrows = options.waitUntilReadyThrows;
    this.createTokenResult = options.createTokenResult ?? { url: "https://fake.modal.run", token: "tok-1" };
  }

  // ---- lifecycle ----
  async poll(): Promise<number | null> {
    return this.pollResult;
  }
  async waitUntilReady(): Promise<void> {
    if (this.waitUntilReadyThrows) throw this.waitUntilReadyThrows;
  }
  async terminate(): Promise<void> {
    this.calls.terminated += 1;
  }
  detach(): void {
    this.calls.detached += 1;
  }
  async tunnels(): Promise<Record<number, unknown>> {
    this.calls.tunnels += 1;
    return {};
  }
  async createConnectToken(params?: { port?: number }): Promise<{ url: string; token: string }> {
    this.calls.tokens.push({ argv: [String(params?.port ?? "")] });
    return this.createTokenResult;
  }

  // ---- exec ----
  exec = async (argv: string[], params?: Record<string, unknown>) => {
    this.calls.exec.push({ argv, params });
    const joined = argv.join(" ");
    const handler = (this.execHandlers ?? []).find((entry) => joined.includes(entry.match));
    const stdout = handler?.stdout ?? "";
    const stderr = handler?.stderr ?? "";
    if (handler?.throws) throw handler.throws;
    const exitCode = handler?.exitCode ?? 0;
    return {
      stdout: { readText: async () => stdout },
      stderr: { readText: async () => stderr },
      wait: async () => exitCode,
    };
  };

  // ---- filesystem ----
  filesystem = {
    readText: async (path: string) => {
      if (!(path in this.files)) throw fileNotFound(`no such file: ${path}`);
      return this.files[path]!;
    },
    writeText: async (data: string, path: string) => {
      // Real Modal rejects a write whose parent directory does not exist, so
      // the fake must too or the parent-creation retry is untested.
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!this.dirs.has(parent) && parent !== WORKSPACE_ROOT && !this.dirs.has(parent + "/")) {
        throw fileNotFound(`directory does not exist: ${parent}`);
      }
      this.files[path] = data;
    },
    listFiles: async (path: string) => [
      { name: "App.tsx", path: `${path}/App.tsx`, type: "file" as const, size: 12 },
      { name: "src", path: `${path}/src`, type: "directory" as const, size: 0 },
    ],
    stat: async (path: string) => {
      if (this.dirs.has(path)) return { size: 0, type: "directory" as const };
      if (path in this.files) return { size: this.files[path]!.length, type: "file" as const };
      throw fileNotFound(`no such path: ${path}`);
    },
    remove: async (path: string) => {
      delete this.files[path];
    },
    makeDirectory: async (path: string) => {
      this.dirs.add(path);
    },
    copyFromLocal: async (_local: string, _remote: string) => undefined,
  };

  /** Test introspection. */
  writtenFiles(): Record<string, string> {
    return { ...this.files };
  }
  madeDirectories(): string[] {
    return [...this.dirs];
  }
}

// errors.ts classifies with instanceof, so fakes must throw the SDK's own
// classes for the mapping under test to be the real one.
export function notFound(message: string): Error {
  return new NotFoundError(message);
}
export function fileNotFound(message: string): Error {
  return new SandboxFilesystemNotFoundError(message);
}
export function alreadyExists(message: string): Error {
  return new AlreadyExistsError(message);
}
export function commandTimeout(message: string): Error {
  return new SandboxTimeoutError(message);
}

export interface FakeClientOptions {
  sandboxes?: FakeSandbox[];
  /** Ids that should reject fromId, simulating a finished/unknown Sandbox. */
  unknownIds?: string[];
  createShouldThrow?: Error;
  /** Sandboxes handed out by create(), in order. */
  spare?: FakeSandbox[];
}

export class FakeModalClient {
  readonly created: Array<{ params: Record<string, unknown> }> = [];
  readonly deleted: string[] = [];
  private next = 0;
  /** Sandboxes this fake hands out, and the ones list() reports. */
  attached: FakeSandbox[];
  /** Optional scripted Sandboxes returned by successive create() calls. */
  spare: FakeSandbox[] = [];
  private unknownIds: Set<string>;
  createShouldThrow?: Error;

  apps = { fromName: async (_name: string) => ({ appId: "app-1", name: _name }) };
  volumes = {
    fromName: async (_name: string) => makeVolume(),
    delete: async () => undefined,
  };
  images = {
    fromName: async (_name: string) => ({ imageId: "img-1" }),
    fromRegistry: () => registryImage,
  };
  secrets = { fromObject: async () => ({ secretId: "sec-1" }) };
  close = () => undefined;

  sandboxes = {
    create: async (_app: unknown, _image: unknown, params: Record<string, unknown>) => {
      this.created.push({ params });
      if (this.createShouldThrow) throw this.createShouldThrow;
      // Creation always yields a fresh Sandbox; `attached` is only what
      // fromId()/list() can see, which is what makes reuse testable.
      const sandbox = this.spare[this.next] ?? new FakeSandbox({ id: `sbx-new-${this.created.length}` });
      this.next += 1;
      return sandbox;
    },
    fromId: async (id: string) => {
      if (this.unknownIds.has(id)) throw notFound(`sandbox ${id} not found`);
      const found = this.attached.find((sandbox) => sandbox.sandboxId === id);
      if (found) return found;
      throw notFound(`sandbox ${id} not found`);
    },
    // Arrow wrappers a real generator method so `this` stays the client:
    // generator methods cannot be arrow functions.
    list: (params?: unknown) => this.listSandboxes(params),
  };

  constructor(options: FakeClientOptions = {}) {
    this.attached = options.sandboxes ?? [];
    this.unknownIds = new Set(options.unknownIds ?? []);
    this.spare = options.spare ?? [];
    this.createShouldThrow = options.createShouldThrow;
  }

  async *listSandboxes(_params?: unknown): AsyncGenerator<FakeSandbox> {
    for (const sandbox of this.attached) yield sandbox;
  }

}

const registryImage = {
  dockerfileCommands: () => registryImage,
  build: async () => ({ imageId: "img-built" }),
  publish: async () => undefined,
};

export function makeVolume(): { volumeId: string; name: string; withMountOptions: (p: unknown) => unknown } {
  const volume = {
    volumeId: "vol-1",
    name: "dai-workspaces",
    withMountOptions(options: unknown) {
      (volume as { mountOptions?: unknown }).mountOptions = options;
      return volume;
    },
  };
  return volume;
}

export function testConfig(overrides: Partial<ModalRuntimeConfig> = {}): ModalRuntimeConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
