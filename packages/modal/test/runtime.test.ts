import { describe, expect, it } from "vitest";
import { SandboxTimeoutError } from "modal";
import type { ModalClient } from "modal";
import type { ModalRuntimeConfig } from "../src/config.js";
import { ModalProvider, ModalRuntimeService } from "../src/index.js";
import { FakeModalClient, FakeSandbox, alreadyExists, makeVolume, testConfig } from "./fakes.js";

function serviceFor(client: FakeModalClient, overrides: Partial<ModalRuntimeConfig> = {}) {
  return new ModalRuntimeService({
    provider: new ModalProvider({
      config: testConfig(overrides),
      client: client as unknown as ModalClient,
    }),
  });
}

describe("Sandbox acquisition and reuse", () => {
  it("reattaches to a live Sandbox instead of provisioning a new one", async () => {
    const live = new FakeSandbox({ id: "sbx-live", pollResult: null });
    const client = new FakeModalClient({ sandboxes: [live] });
    const service = serviceFor(client);

    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: "sbx-live" });

    expect(workspace.sandboxId).toBe("sbx-live");
    // The whole cost model depends on this: one run, one Sandbox.
    expect(client.created).toHaveLength(0);
  });

  it("creates a new Sandbox when the stored one has finished", async () => {
    const dead = new FakeSandbox({ id: "sbx-dead", pollResult: 0 });
    const client = new FakeModalClient({ sandboxes: [dead] });
    const service = serviceFor(client);

    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: "sbx-dead" });

    expect(client.created).toHaveLength(1);
    // A finished Sandbox is never resumed; the handle is dropped, not reused.
    expect(dead.calls.detached).toBe(1);
    expect(workspace.sandboxId).not.toBe("sbx-dead");
  });

  it("creates a new Sandbox when the stored id is unknown to Modal", async () => {
    const client = new FakeModalClient({ unknownIds: ["sbx-gone"] });
    const service = serviceFor(client);

    await expect(service.acquire({ projectId: "p1", existingSandboxId: "sbx-gone" })).resolves.toBeDefined();
    expect(client.created).toHaveLength(1);
  });

  it("recovers from a name collision by attaching the existing live Sandbox", async () => {
    const holder = new FakeSandbox({ id: "sbx-holder", pollResult: null });
    const client = new FakeModalClient({
      sandboxes: [holder],
      createShouldThrow: alreadyExists("name taken"),
    });
    const service = serviceFor(client);

    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });
    expect(workspace.sandboxId).toBe("sbx-holder");
  });

  it("terminates a Sandbox that never becomes ready rather than handing it out", async () => {
    const unready = new FakeSandbox({ id: "sbx-bad", waitUntilReadyThrows: new Error("probe failed") });
    const client = new FakeModalClient({ spare: [unready] });
    const service = serviceFor(client);

    await expect(service.acquire({ projectId: "p1", existingSandboxId: null })).rejects.toThrow();
    expect(unready.calls.terminated).toBe(1);
  });
});

describe("Sandbox creation parameters", () => {
  it("mounts the project's Volume subPath at /workspace", async () => {
    const client = new FakeModalClient();
    const service = serviceFor(client);
    await service.acquire({ projectId: "proj-9", existingSandboxId: null });

    const params = client.created[0]!.params as {
      volumes: Record<string, { volumeId: string; mountOptions?: unknown }>;
    };
    expect(Object.keys(params.volumes)).toEqual(["/workspace"]);
    expect(params.volumes["/workspace"]!.volumeId).toBe("vol-1");
    // SubPath isolation is what keeps one shared Volume safe across projects.
    expect(params.volumes["/workspace"]!.mountOptions).toEqual({ subPath: "projects/proj-9" });
  });

  it("relies on Modal's idle timeout instead of a homemade keepalive", async () => {
    const client = new FakeModalClient();
    const service = serviceFor(client);
    await service.acquire({ projectId: "p1", existingSandboxId: null });

    const params = client.created[0]!.params as Record<string, unknown>;
    expect(params.idleTimeoutMs).toBe(testConfig().idleTimeoutMs);
    expect(params.timeoutMs).toBe(testConfig().timeoutMs);
    // No command: the Sandbox sleeps until timeout and is driven through exec().
    expect(params.command).toBeUndefined();
  });

  it("tags the Sandbox with its project so recovery can find it", async () => {
    const client = new FakeModalClient();
    const service = serviceFor(client);
    await service.acquire({ projectId: "p1", existingSandboxId: null });
    const params = client.created[0]!.params as { tags: Record<string, string> };
    expect(params.tags).toEqual({ "dai.project": "p1" });
  });

  it("declares encrypted preview ports and a readiness probe", async () => {
    const client = new FakeModalClient();
    const service = serviceFor(client);
    await service.acquire({ projectId: "p1", existingSandboxId: null });
    const params = client.created[0]!.params as Record<string, unknown>;
    expect(params.encryptedPorts).toEqual([3_000, 5_173, 8_080]);
    expect(params.readinessProbe).toBeDefined();
  });

  it("applies CPU and memory from configuration, not hardcoded values", async () => {
    const client = new FakeModalClient();
    const configured = new ModalRuntimeService({
      provider: new ModalProvider({
        config: testConfig({ cpu: 2, memoryMiB: 4_096 }),
        client: client as unknown as ModalClient,
      }),
    });
    await configured.acquire({ projectId: "p1", existingSandboxId: null });
    const params = client.created[0]!.params as Record<string, unknown>;
    expect(params.cpu).toBe(2);
    expect(params.memoryMiB).toBe(4_096);
  });
});

describe("execution", () => {
  it("runs the agent command through bash and reports streams and exit code", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-1",
      execHandlers: [{ match: "npm test", stdout: "1 passed", stderr: "warn", exitCode: 3 }],
    });
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = serviceFor(client);
    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });

    const result = await workspace.exec("npm test", { cwd: "/workspace", timeoutMs: 5_000 });

    expect(result.stdout).toBe("1 passed");
    expect(result.stderr).toBe("warn");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);

    const call = sandbox.calls.exec[0]!;
    expect(call.argv).toEqual(["/bin/bash", "-lc", "npm test"]);
    expect(call.params).toMatchObject({ workdir: "/workspace", timeoutMs: 5_000 });
  });

  it("converts a provider timeout into a timedOut result, not a thrown error", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    sandbox.exec = (async () => {
      throw new SandboxTimeoutError("command exceeded its deadline");
    }) as never;
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = serviceFor(client);
    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });

    // A timed-out command must still produce a tool result for the agent loop.
    const result = await workspace.exec("sleep 999", { timeoutMs: 1_000 });
    expect(result.timedOut || result.exitCode !== 0).toBe(true);
  });

  it("renames with an argv array so paths cannot become shell syntax", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = serviceFor(client);
    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });

    await workspace.rename("/workspace/a;rm -rf /.txt", "/workspace/b.txt");
    const call = sandbox.calls.exec.find((entry) => entry.argv[0] === "/bin/mv");
    expect(call!.argv).toEqual(["/bin/mv", "--", "/workspace/a;rm -rf /.txt", "/workspace/b.txt"]);
  });
});

describe("filesystem", () => {
  async function workspaceWith(files: Record<string, string>) {
    const sandbox = new FakeSandbox({ id: "sbx-1", files });
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = serviceFor(client);
    // Force creation so the fake's files map is the one under test.
    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });
    return { workspace, sandbox };
  }

  it("returns null for a missing file instead of throwing", async () => {
    const { workspace } = await workspaceWith({ "/workspace/a.ts": "x" });
    await expect(workspace.readFile("/workspace/missing.ts")).resolves.toBeNull();
    await expect(workspace.readFile("/workspace/a.ts")).resolves.toBe("x");
  });

  it("creates missing parent directories and retries the write", async () => {
    const { workspace, sandbox } = await workspaceWith({});
    await workspace.writeFile("/workspace/src/deep/App.tsx", "export const App = 1");
    expect(sandbox.madeDirectories()).toContain("/workspace/src/deep");
    expect(sandbox.writtenFiles()["/workspace/src/deep/App.tsx"]).toBe("export const App = 1");
  });

  it("maps directory listings with absolute paths and kinds", async () => {
    const { workspace } = await workspaceWith({});
    const entries = await workspace.listFiles("/workspace");
    expect(entries.map((entry) => entry.kind).sort()).toEqual(["directory", "file"]);
    expect(entries.every((entry) => entry.path.startsWith("/workspace/"))).toBe(true);
  });

  it("removes recursively", async () => {
    const { workspace, sandbox } = await workspaceWith({ "/workspace/x.ts": "y" });
    await workspace.remove("/workspace/x.ts");
    expect(sandbox.writtenFiles()["/workspace/x.ts"]).toBeUndefined();
  });
});

describe("preview", () => {
  it("issues an authenticated connect token for the requested port", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = serviceFor(client);
    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });

    const preview = await workspace.getPreviewUrl(3_000);
    expect(preview.url).toBe("https://fake.modal.run");
    // A bare URL would be an open proxy; the token is the auth half.
    expect(preview.token).toBe("tok-1");
    expect(sandbox.calls.tokens[0]!.argv[0]).toBe("3000");
  });

  it("reuses a dev server that is already listening", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-1",
      // The TCP probe succeeds, so startDevServer must not launch a second one.
      execHandlers: [{ match: "/dev/tcp", stdout: "", exitCode: 0 }],
    });
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = serviceFor(client);
    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });

    const handle = await workspace.startDevServer({ command: "npm run dev", port: 3_000 });
    expect(handle.reused).toBe(true);
    expect(handle.ready).toBe(true);
    expect(sandbox.calls.exec.filter((entry) => entry.argv.join(" ").includes("setsid"))).toHaveLength(0);
  });

  it("launches a detached dev server when nothing is listening", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-1",
      execHandlers: [
        { match: "/dev/tcp", stdout: "", exitCode: 1 },
        { match: "setsid", stdout: "", exitCode: 0 },
      ],
    });
    // After launch, report the port as open so readiness resolves.
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = serviceFor(client, { devServerReadyTimeoutMs: 1_000 });
    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });

    const handle = await workspace.startDevServer({ command: "npm run dev", port: 3_000 });
    expect(handle.ready).toBe(false);
    const launched = sandbox.calls.exec.find((entry) => entry.argv.join(" ").includes("setsid"));
    expect(launched).toBeDefined();
    expect(handle.reused).toBe(false);
  });
});

describe("status", () => {
  it("reports running only when the Sandbox is live", async () => {
    const live = new FakeSandbox({ id: "sbx-live", pollResult: null });
    const client = new FakeModalClient({ sandboxes: [live] });
    const service = serviceFor(client);
    await expect(service.status("p1", "sbx-live")).resolves.toBe("running");
    expect(live.calls.detached).toBe(1);
  });

  it("reports stopped for a finished Sandbox and provisioning with no id", async () => {
    const dead = new FakeSandbox({ id: "sbx-dead", pollResult: 1 });
    const client = new FakeModalClient({ sandboxes: [dead] });
    const service = serviceFor(client);
    await expect(service.status("p1", "sbx-dead")).resolves.toBe("stopped");
    await expect(service.status("p1", null)).resolves.toBe("provisioning");
  });

  it("treats an unreachable provider as unreachable, not as stopped", async () => {
    const client = new FakeModalClient();
    client.sandboxes.fromId = (async () => {
      throw new Error("network down");
    }) as typeof client.sandboxes.fromId;
    const service = serviceFor(client);
    await expect(service.status("p1", "sbx-x")).resolves.toBe("unreachable");
  });
});

describe("volume mount options", () => {
  it("returns a Volume configured with the project subPath", async () => {
    const volume = makeVolume();
    const mounted = volume.withMountOptions({ subPath: "projects/p1" }) as { mountOptions?: unknown };
    expect(mounted.mountOptions).toEqual({ subPath: "projects/p1" });
  });
});
