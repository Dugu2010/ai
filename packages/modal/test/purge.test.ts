import { describe, expect, it } from "vitest";
import type { ModalClient } from "modal";
import type { ModalRuntimeConfig } from "../src/config.js";
import { ModalProvider, ModalRuntimeService, purgeTarget, RuntimeOperationError } from "../src/index.js";
import { FakeModalClient, FakeSandbox, testConfig } from "./fakes.js";

function serviceFor(client: FakeModalClient, overrides: Partial<ModalRuntimeConfig> = {}) {
  return new ModalRuntimeService({
    provider: new ModalProvider({
      config: testConfig(overrides),
      client: client as unknown as ModalClient,
    }),
  });
}

describe("purgeTarget — the guard against destroying the shared Volume", () => {
  it("resolves a normal project id to its own directory", () => {
    expect(purgeTarget("abc-123")).toBe("projects/abc-123");
    expect(purgeTarget("7c9e6679-7425-40de-944b-e07fc1f90ae7")).toBe(
      "projects/7c9e6679-7425-40de-944b-e07fc1f90ae7"
    );
  });

  // Every one of these would widen `rm -rf` beyond a single project directory.
  const unsafe = [
    "",
    " ",
    "..",
    ".",
    "../../..",
    "projects/../..",
    "/etc",
    "a/b",
    "a b",
    "a;rm -rf /",
    "a$(id)",
    "a\nb",
    ".hidden",
    "-rf",
    "x".repeat(200),
    "a'b",
    'a"b',
    "a|b",
    "a&b",
    "a`b",
  ];

  it.each(unsafe)("refuses the project id %j", (projectId) => {
    expect(() => purgeTarget(projectId)).toThrow(RuntimeOperationError);
    try {
      purgeTarget(projectId);
    } catch (error) {
      expect((error as RuntimeOperationError).failure).toBe("invalid");
    }
  });

  it("never returns the mount root or an empty segment", () => {
    for (const id of ["a", "a-b", "a_b.1"]) {
      const target = purgeTarget(id);
      expect(target.startsWith("projects/")).toBe(true);
      expect(target).not.toBe("projects");
      expect(target.split("/")).toHaveLength(2);
    }
  });
});

describe("ModalRuntimeService.purgeWorkspace", () => {
  it("removes the absolute path inside the mounted Volume, not a relative guess", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-purge",
      execHandlers: [{ match: "rm -rf", stdout: "gone", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await serviceFor(client).purgeWorkspace("proj-9");

    const argv = sandbox.calls.exec[0]!.argv;
    const command = argv.join(" ");
    expect(command).toContain("rm -rf");
    // The bug this guards: a relative "projects/proj-9" resolves against the
    // Sandbox's default cwd, so nothing on the Volume is ever reclaimed.
    expect(argv).toContain("/mnt/dai-volumes/projects/proj-9");
    expect(command).not.toMatch(/rm -rf --\s+projects\/proj-9/);
  });

  it("mounts the whole Volume so the project directory itself can go", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-purge",
      execHandlers: [{ match: "rm -rf", stdout: "gone", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await serviceFor(client).purgeWorkspace("proj-9");
    expect(client.created[0]!.params.volumes).toMatchObject({ "/mnt/dai-volumes": expect.anything() });
  });

  it("refuses an unsafe id before provisioning any compute", async () => {
    const client = new FakeModalClient({ sandboxes: [] });
    await expect(serviceFor(client).purgeWorkspace("../..")).rejects.toThrow(RuntimeOperationError);
    expect(client.created).toHaveLength(0);
  });

  it("terminates the helper Sandbox once the removal is done", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-purge",
      execHandlers: [{ match: "rm -rf", stdout: "gone", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await serviceFor(client).purgeWorkspace("proj-9");
    expect(sandbox.calls.terminated).toBe(1);
  });

  it("treats an already-absent workspace as success", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-purge",
      execHandlers: [{ match: "rm -rf", stdout: "absent", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await expect(serviceFor(client).purgeWorkspace("proj-9")).resolves.toBeUndefined();
  });

  it("reports a failed removal instead of claiming the files are gone", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-purge",
      execHandlers: [{ match: "rm -rf", stdout: "", exitCode: 1 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await expect(serviceFor(client).purgeWorkspace("proj-9")).rejects.toThrow(/did not complete cleanly/);
    // A failed purge must still release the Sandbox it opened.
    expect(sandbox.calls.terminated).toBe(1);
  });

  it("never deletes the shared Volume itself", async () => {
    let volumeDeletes = 0;
    const sandbox = new FakeSandbox({
      id: "sbx-purge",
      execHandlers: [{ match: "rm -rf", stdout: "gone", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    client.volumes.delete = async () => {
      volumeDeletes += 1;
    };
    await serviceFor(client).purgeWorkspace("proj-9");
    expect(volumeDeletes).toBe(0);
  });
});
