import { describe, expect, it } from "vitest";
import type { ModalClient } from "modal";
import type { ModalRuntimeConfig } from "../src/config.js";
import { ModalProvider, ModalRuntimeService } from "../src/index.js";
import { FakeModalClient, FakeSandbox, testConfig } from "./fakes.js";

function serviceFor(client: FakeModalClient, overrides: Partial<ModalRuntimeConfig> = {}) {
  return new ModalRuntimeService({
    provider: new ModalProvider({
      config: testConfig(overrides),
      client: client as unknown as ModalClient,
    }),
  });
}

/**
 * These maintenance Sandboxes mount the shared Volume at /mnt/dai-volumes and
 * are created without a `workdir`, so every path handed to them has to be
 * absolute against that mount. purgeWorkspace has had a guard for this all
 * along; duplicateWorkspace and measureWorkspaceBytes are the same shape of
 * call and must not regress to a bare `projects/<id>`.
 */
describe("ModalRuntimeService.duplicateWorkspace", () => {
  it("copies between absolute paths inside the mounted Volume", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-dup",
      execHandlers: [{ match: "cp -a", stdout: "", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await serviceFor(client).duplicateWorkspace("proj-src", "proj-dst");

    const argv = sandbox.calls.exec[0]!.argv;
    expect(argv).toContain("/mnt/dai-volumes/projects/proj-src");
    expect(argv).toContain("/mnt/dai-volumes/projects/proj-dst");
    // The bug this guards: a relative source resolves against the Sandbox's own
    // directory, so the fork silently copies nothing while reporting success.
    expect(argv).not.toContain("projects/proj-src");
  });

  it("mounts the whole Volume and releases the helper Sandbox", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-dup",
      execHandlers: [{ match: "cp -a", stdout: "", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await serviceFor(client).duplicateWorkspace("proj-src", "proj-dst");

    expect(client.created[0]!.params.volumes).toMatchObject({ "/mnt/dai-volumes": expect.anything() });
    expect(sandbox.calls.terminated).toBe(1);
  });

  it("fails the copy when cp exits non-zero", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-dup",
      execHandlers: [{ match: "cp -a", stdout: "", exitCode: 1 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await expect(serviceFor(client).duplicateWorkspace("proj-src", "proj-dst")).rejects.toThrow(
      /Unable to copy workspace/
    );
    expect(sandbox.calls.terminated).toBe(1);
  });
});

describe("ModalRuntimeService.measureWorkspaceBytes", () => {
  it("measures the absolute path inside the mounted Volume", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-measure",
      execHandlers: [{ match: "du -sb", stdout: "4096\n", exitCode: 0 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    const bytes = await serviceFor(client).measureWorkspaceBytes("proj-9");

    expect(bytes).toBe(4096);
    const argv = sandbox.calls.exec[0]!.argv;
    expect(argv).toContain("/mnt/dai-volumes/projects/proj-9");
    // A relative target makes `du` fail into /dev/null, which reads as an empty
    // workspace rather than as a failed measurement.
    expect(argv).not.toContain("projects/proj-9");
    expect(sandbox.calls.terminated).toBe(1);
  });

  it("returns null when the measurement is not a number", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-measure",
      execHandlers: [{ match: "du -sb", stdout: "", exitCode: 1 }],
    });
    const client = new FakeModalClient({ sandboxes: [], spare: [sandbox] });
    await expect(serviceFor(client).measureWorkspaceBytes("proj-9")).resolves.toBeNull();
  });
});
