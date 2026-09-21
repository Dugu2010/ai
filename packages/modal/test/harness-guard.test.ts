import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModalClient } from "modal";
import { ModalProvider, ModalRuntimeService, configFromEnv } from "../src/index.js";
import { FakeModalClient, FakeSandbox, testConfig } from "./fakes.js";

/**
 * Everything that keeps this suite free to run anywhere.
 *
 * The rule the package lives under is that no default test may open a socket,
 * because on this provider a socket is a Sandbox and a Sandbox is money. These
 * assertions fail if the harness is ever widened to reach the network, if the
 * live suite is added back to the default include patterns, or if a test starts
 * constructing a real client.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the default run cannot reach Modal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("excludes test/live from the default config", () => {
    const config = read("../vitest.config.ts");
    expect(config).toContain("test/**/*.test.ts");
    expect(config).toContain("test/live/**");
    // The exclusion must be an `exclude`, not an include of the live directory.
    expect(config).toMatch(/exclude:\s*\[[^\]]*"test\/live\/\*\*"/);
    expect(config).not.toMatch(/include:\s*\[[^\]]*"test\/live/);
  });

  it("keeps the live config pointed only at test/live", () => {
    const live = read("../vitest.live.config.ts");
    expect(live).toMatch(/include:\s*\[\s*"test\/live\/\*\*\/\*\.test\.ts"/);
    expect(live).toContain("MODAL_TOKEN_ID");
  });

  it("skips the live suite when no credentials are present", () => {
    const source = read("./live/sandbox.live.test.ts");
    // The live file must gate itself on the token pair, not assume one exists.
    expect(source).toMatch(/process\.env\.MODAL_TOKEN_ID\s*&&\s*process\.env\.MODAL_TOKEN_SECRET/);
    expect(source).toMatch(/configured \? describe : describe\.skip/);
  });

  it("resolves runtime configuration with no credentials in the environment", () => {
    const config = configFromEnv({});
    expect(config.volumeName).toBe("dai-workspaces");
    expect(config.previewPorts.length).toBeGreaterThan(0);
    // Credentials are never read here; the SDK takes them from the process.
    expect(JSON.stringify(config)).not.toMatch(/TOKEN|SECRET/i);
  });

  it("performs a whole acquisition-and-work cycle without touching the network", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("a default test tried to make a request")));
    vi.stubGlobal("fetch", fetchSpy);

    const sandbox = new FakeSandbox({
      id: "sbx-1",
      files: { "/workspace/a.ts": "alpha" },
      execHandlers: [
        { match: "dai-restore", stdout: "DAI_RESTORE_RESULT[]" },
        { match: "dai-read", stdout: "DAI_READ_RESULTe30=" },
      ],
    });
    const client = new FakeModalClient({ spare: [sandbox] });
    const service = new ModalRuntimeService({
      provider: new ModalProvider({ config: testConfig(), client: client as unknown as ModalClient }),
    });

    const workspace = await service.acquire({ projectId: "p1", existingSandboxId: null });
    expect(await workspace.readFile("/workspace/a.ts")).toBe("alpha");
    await workspace.exec("npm test");
    await workspace.applyFileMutations([{ path: "/workspace/a.ts", content: "beta", expectCurrent: null }]);
    await workspace.readFilesBatch(["/workspace/a.ts"]);
    await workspace.getPreviewUrl(3_000);
    workspace.close();

    // The only client in play is the in-memory double, so nothing was fetched and
    // nothing was billed.
    expect(fetchSpy).not.toHaveBeenCalled();
    // exec + the two batched primitives: three commands, all served in memory.
    expect(sandbox.calls.exec).toHaveLength(3);
  });

  it("does not build a real client when one is injected", () => {
    const client = new FakeModalClient();
    const provider = new ModalProvider({ config: testConfig(), client: client as unknown as ModalClient });
    expect(provider.client).toBe(client as unknown as ModalClient);
    expect(client.created).toHaveLength(0);
  });
});
