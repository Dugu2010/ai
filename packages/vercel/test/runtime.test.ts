import { describe, expect, it, vi, beforeEach } from "vitest";
import { VercelRuntimeService } from "../src/runtime.js";
import { testConfig } from "./fakes.js";

/**
 * The service layer is where the cost promises are kept or broken. These tests
 * pin the three that matter: never boot to ask a question, never boot a bigger
 * machine than the caller asked for, and always know whether a boot happened.
 */

const hoisted = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  createSandbox: vi.fn(),
  getOrCreateDrive: vi.fn(),
  listDrives: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: (params: { name: string; resume?: boolean }) => hoisted.getSandbox(params),
    create: (params: Record<string, unknown>) => hoisted.createSandbox(params),
  },
  Drive: {
    getOrCreate: (params: Record<string, unknown>) => hoisted.getOrCreateDrive(params),
    list: () => hoisted.listDrives(),
  },
  APIError: class APIError extends Error {},
  StreamError: class StreamError extends Error {},
}));

function fakeSandbox(name: string, status = "running") {
  return {
    name,
    status,
    activeCpuUsageMs: 1_500,
    async runCommand() {
      return { exitCode: 0, async stdout() { return ""; }, async stderr() { return ""; }, async kill() {} };
    },
    async readFileToBuffer() {
      return null;
    },
    async writeFiles() {},
    domain: (port: number) => `https://${name}-${port}.vercel.run`,
    async stop() {
      return { snapshot: { id: "snap-1" } };
    },
    fs: {
      async readdir() { return []; },
      async stat() { return { size: 0, isDirectory: () => true }; },
      async rm() {},
      async rename() {},
      async mkdir() {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.listDrives.mockResolvedValue({ toArray: async () => [] });
  hoisted.getOrCreateDrive.mockResolvedValue({ name: "dai-workspace-p1", snapshot: () => ({ drive: "x", mode: "snapshot" }) });
});

describe("liveness checks never wake a machine", () => {
  it("asks for a sandbox without resuming it", async () => {
    hoisted.getSandbox.mockResolvedValue(fakeSandbox("dai-p1"));
    const service = new VercelRuntimeService({ config: testConfig() });

    expect(await service.status("p1", null)).toBe("running");
    expect(hoisted.getSandbox).toHaveBeenCalledWith(expect.objectContaining({ name: "dai-p1", resume: false }));
  });

  it("maps a pending session to provisioning rather than pretending it is usable", async () => {
    hoisted.getSandbox.mockResolvedValue(fakeSandbox("dai-p1", "pending"));
    expect(await new VercelRuntimeService({ config: testConfig() }).status("p1")).toBe("provisioning");
  });

  it("reports a stopped sandbox as stopped, so the UI can call it hibernated", async () => {
    hoisted.getSandbox.mockResolvedValue(fakeSandbox("dai-p1", "stopped"));
    expect(await new VercelRuntimeService({ config: testConfig() }).status("p1")).toBe("stopped");
  });

  it("distinguishes an absent sandbox from an unreachable control plane", async () => {
    const notFound = Object.assign(new Error("not found"), { response: { status: 404 } });
    hoisted.getSandbox.mockRejectedValue(notFound);
    expect(await new VercelRuntimeService({ config: testConfig() }).status("p1")).toBe("provisioning");

    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 503 } }));
    expect(await new VercelRuntimeService({ config: testConfig() }).status("p1")).toBe("unreachable");
  });
});

describe("resource tiers", () => {
  it("boots at the smallest tier unless told otherwise", async () => {
    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-p1"));

    const service = new VercelRuntimeService({ config: testConfig() });
    await service.acquire({ projectId: "p1" });

    expect(hoisted.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ resources: { vcpus: 1 } }));
  });

  it("clamps an out-of-range request to the largest allowed machine", async () => {
    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-p1"));

    await new VercelRuntimeService({ config: testConfig() }).acquire({ projectId: "p1", resourceTier: 99 });
    expect(hoisted.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ resources: { vcpus: 4 } }));
  });

  it("honours a plan that removes the largest tier entirely", async () => {
    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-p1"));
    const config = { ...testConfig(), tiers: [{ vcpus: 1, label: "small" as const }] };

    await new VercelRuntimeService({ config }).acquire({ projectId: "p1", resourceTier: 7 });
    expect(hoisted.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ resources: { vcpus: 1 } }));
  });

  it("mounts the project drive at the workspace path and names the sandbox after the project", async () => {
    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-p1"));

    await new VercelRuntimeService({ config: testConfig() }).acquire({ projectId: "p1" });
    const params = hoisted.createSandbox.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.name).toBe("dai-p1");
    expect(Object.keys(params.mounts as object)).toEqual(["/workspace"]);
    expect(params.persistent).toBe(true);
    expect(params.keepLastSnapshots).toEqual({ count: 1 });
  });
});

describe("creation is distinguishable from a resume", () => {
  it("reports reattached when the sandbox already existed", async () => {
    hoisted.getSandbox.mockResolvedValue(fakeSandbox("dai-p1"));
    const acquired = await new VercelRuntimeService({ config: testConfig() }).acquireDetailed({ projectId: "p1" });

    expect(acquired.reattached).toBe(true);
    expect(hoisted.createSandbox).not.toHaveBeenCalled();
  });

  it("reports a fresh boot only when it created one", async () => {
    hoisted.getSandbox
      .mockRejectedValueOnce(Object.assign(new Error("not found"), { response: { status: 404 } }))
      .mockResolvedValue(fakeSandbox("dai-p1"));
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-p1"));

    const acquired = await new VercelRuntimeService({ config: testConfig() }).acquireDetailed({ projectId: "p1" });
    expect(acquired.reattached).toBe(false);
    expect(hoisted.createSandbox).toHaveBeenCalledTimes(1);
  });
});

describe("workspace lifecycle", () => {
  it("provisioning a workspace creates a drive and no compute", async () => {
    await new VercelRuntimeService({ config: testConfig() }).ensureWorkspace("p1");
    expect(hoisted.getOrCreateDrive).toHaveBeenCalled();
    expect(hoisted.createSandbox).not.toHaveBeenCalled();
    expect(hoisted.getSandbox).not.toHaveBeenCalled();
  });

  it("destroying stops without deleting the durable workspace", async () => {
    const sandbox = fakeSandbox("dai-p1");
    const stop = vi.spyOn(sandbox, "stop");
    hoisted.getSandbox.mockResolvedValue(sandbox);

    await new VercelRuntimeService({ config: testConfig() }).destroy("p1");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("refuses to fork with no mirror configured, instead of piping bytes through two sandboxes", async () => {
    await expect(new VercelRuntimeService({ config: testConfig() }).duplicateWorkspace("a", "b")).rejects.toThrow(/mirror/);
  });

  it("copies a workspace entirely inside object storage", async () => {
    const mirror = { copyProject: vi.fn().mockResolvedValue(undefined) } as unknown;
    await new VercelRuntimeService({ config: testConfig(), mirror: mirror as never }).duplicateWorkspace("a", "b");
    expect((mirror as { copyProject: ReturnType<typeof vi.fn> }).copyProject).toHaveBeenCalledWith("a", "b");
    expect(hoisted.createSandbox).not.toHaveBeenCalled();
  });

  it("purging deletes the drive and the mirror together", async () => {
    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    const drive = { delete: vi.fn().mockResolvedValue(undefined) };
    hoisted.getOrCreateDrive.mockResolvedValue(drive);
    const mirror = { purgeProject: vi.fn().mockResolvedValue(undefined) };

    await new VercelRuntimeService({ config: testConfig(), mirror: mirror as never }).purgeWorkspace("p1");
    expect(drive.delete).toHaveBeenCalled();
    expect(mirror.purgeProject).toHaveBeenCalledWith("p1");
  });
});

describe("shared dependency cache", () => {
  const cacheConfig = () => ({ ...testConfig(), cacheDriveName: "dai-deps", cachePath: "/dai-cache" });

  it("mounts the cache read-only beside the workspace and points package managers at it", async () => {
    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-p1"));
    hoisted.getOrCreateDrive.mockImplementation(async (params: { name: string }) =>
      params.name === "dai-deps"
        ? { name: params.name, snapshot: () => ({ drive: "dai-deps", mode: "snapshot" }) }
        : { name: params.name }
    );

    await new VercelRuntimeService({ config: cacheConfig() }).acquire({ projectId: "p1" });
    const params = hoisted.createSandbox.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(params.mounts as object).sort()).toEqual(["/dai-cache", "/workspace"]);
    const env = params.env as Record<string, string>;
    expect(env.npm_config_cache).toBe("/dai-cache/npm");
    expect(env.PNPM_HOME).toBe("/dai-cache/pnpm");
  });

  it("still boots when the cache drive has never been written to", async () => {
    // A snapshot of an empty drive is refused by the platform; that must cost a
    // slower install, not the project.
    hoisted.getSandbox.mockRejectedValue(Object.assign(new Error("not found"), { response: { status: 404 } }));
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-p1"));
    hoisted.getOrCreateDrive.mockImplementation(async (params: { name: string }) => {
      if (params.name === "dai-deps") throw Object.assign(new Error("drive_not_initialized"), { response: { status: 400 } });
      return { name: params.name };
    });

    await new VercelRuntimeService({ config: cacheConfig() }).acquire({ projectId: "p1" });
    const params = hoisted.createSandbox.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(params.mounts as object)).toEqual(["/workspace"]);
    expect(params.env).toBeUndefined();
  });

  it("asks for a writer only when a cache drive is configured", async () => {
    await expect(new VercelRuntimeService({ config: testConfig() }).acquireCacheWriter()).rejects.toThrow(/VERCEL_CACHE_DRIVE/);
  });

  it("mounts the cache read-write for the writer, and nothing else", async () => {
    hoisted.getOrCreateDrive.mockResolvedValue({ name: "dai-deps" });
    hoisted.createSandbox.mockResolvedValue(fakeSandbox("dai-cache-writer"));

    await new VercelRuntimeService({ config: cacheConfig() }).acquireCacheWriter();
    const params = hoisted.createSandbox.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.persistent).toBe(false);
    expect(params.name).toBe("dai-cache-writer");
    expect(hoisted.getOrCreateDrive).toHaveBeenCalledWith(expect.objectContaining({ name: "dai-deps" }));
  });
});
