/**
 * LIVE Modal integration tests. NOT part of `bun run test`.
 *
 * These create real Sandboxes and cost real (small) Modal time, so they are
 * excluded from the default run and must be invoked deliberately:
 *
 *   MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... DATABASE_URL=... \
 *     bunx vitest run --config packages/modal/vitest.live.config.ts
 *
 * Until that has been run against a funded Modal account, no claim in this
 * repository about end-to-end Modal behaviour has been verified.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModalProvider, ModalRuntimeService, configFromEnv } from "../../src/index.js";

const configured = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
const maybe = configured ? describe : describe.skip;

if (!configured) {
  console.warn("[live] MODAL_TOKEN_ID / MODAL_TOKEN_SECRET absent — live Modal tests skipped.");
}

maybe("Modal live runtime", () => {
  let service: ModalRuntimeService;
  const projectId = `dai-live-${Date.now().toString(36)}`;

  beforeAll(() => {
    service = new ModalRuntimeService({ provider: new ModalProvider({ config: configFromEnv() }) });
  }, 300_000);

  afterAll(async () => {
    if (!service) return;
    await service.destroy(projectId).catch(() => undefined);
    await service.purgeWorkspace(projectId).catch(() => undefined);
    service.close();
  }, 300_000);

  it("creates a Sandbox, writes to the Volume, and reads it back after recreation", async () => {
    const first = await service.acquire({ projectId, existingSandboxId: null });
    expect(await first.isAlive()).toBe(true);

    await first.writeFile("/workspace/hello.txt", "from-modal");
    const listed = await first.listFiles("/workspace");
    expect(listed.some((entry) => entry.name === "hello.txt")).toBe(true);

    const preview = await first.getPreviewUrl(3_000);
    expect(preview.url).toMatch(/^https:\/\//);
    expect(preview.token).toBeTruthy();

    // The durability claim: drop compute entirely, then mount it again.
    await first.terminate();
    const second = await service.acquire({ projectId, existingSandboxId: null });
    expect(second.sandboxId).not.toBe(first.sandboxId);
    await expect(second.readFile("/workspace/hello.txt")).resolves.toBe("from-modal");
    second.close();
  }, 300_000);

  it("reattaches to a running Sandbox rather than creating a second one", async () => {
    const first = await service.acquire({ projectId, existingSandboxId: null });
    const second = await service.acquire({ projectId, existingSandboxId: first.sandboxId });
    expect(second.sandboxId).toBe(first.sandboxId);
    first.close();
    second.close();
  }, 300_000);

  it("execs a command and reports stdout plus a non-zero exit code", async () => {
    const workspace = await service.acquire({ projectId, existingSandboxId: null });
    const ok = await workspace.exec("echo hello && node -v");
    expect(ok.stdout).toContain("hello");
    expect(ok.exitCode).toBe(0);
    expect(ok.timedOut).toBe(false);

    const failed = await workspace.exec("node -e 'process.exit(4)'");
    expect(failed.exitCode).toBe(4);

    const slow = await workspace.exec("sleep 30", { timeoutMs: 2_000 });
    expect(slow.timedOut || (slow.exitCode ?? 0) !== 0).toBe(true);
    workspace.close();
  }, 300_000);

  it("confines file operations to the mounted workspace", async () => {
    const workspace = await service.acquire({ projectId, existingSandboxId: null });
    // /etc is outside the Volume mount and must not be writable through the tool.
    await expect(workspace.readFile("/etc/shadow")).resolves.toBeNull();
    const stat = await workspace.stat("/workspace");
    expect(stat?.isDirectory).toBe(true);
    workspace.close();
  }, 300_000);

  it("starts a dev server once and reuses it while healthy", async () => {
    const workspace = await service.acquire({ projectId, existingSandboxId: null });
    await workspace.writeFile(
      "/workspace/server.cjs",
      "require('http').createServer((_q,s)=>s.end('ok')).listen(3000,'0.0.0.0')"
    );
    const started = await workspace.startDevServer({ command: "node server.cjs", port: 3_000, cwd: "/workspace" });
    expect(started.ready).toBe(true);
    const again = await workspace.startDevServer({ command: "node server.cjs", port: 3_000, cwd: "/workspace" });
    expect(again.reused).toBe(true);
    await workspace.stopDevServer(3_000);
    workspace.close();
  }, 300_000);
});
