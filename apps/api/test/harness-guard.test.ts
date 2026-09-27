import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@dai/nim";
import { runAgentLoop } from "../src/lib/agent-loop.js";
import { LoopDetector } from "../src/lib/loop-detector.js";
import { DEFAULT_BUDGET_LIMITS, RuntimeBudget } from "../src/lib/runtime-policy.js";
import { FakeWorkspace, recordingEmitter, scriptedNim } from "./fakes.js";

vi.mock("@dai/db", async () => {
  const fakes = await import("./fakes.js");
  return fakes.installMemoryDb(fakes.memoryCheckpointDb()) as Record<string, unknown>;
});

/**
 * The same rule as in `packages/modal`: a default test must not be able to
 * reach a provider, because every reach is a billable Sandbox command or model
 * call. Here the guarantee is that the loop's only contacts are the injected
 * workspace, the injected model client and the two callbacks.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the default API run cannot spend money", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("excludes test/live from the vitest config", () => {
    const config = read("../vitest.config.ts");
    expect(config).toMatch(/exclude:\s*\[[^\]]*"test\/live\/\*\*"/);
    expect(config).not.toMatch(/include:\s*\[[^\]]*"test\/live/);
  });

  it("drives a whole run without a single network call", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("a default test tried to make a request")));
    vi.stubGlobal("fetch", fetchSpy);

    const workspace = new FakeWorkspace({ files: { "/workspace/src/a.ts": "alpha" } });
    const { nim } = scriptedNim([
      { toolCalls: [{ name: "read_file", arguments: { path: "/workspace/src/a.ts" } }] },
      { toolCalls: [{ name: "run_command", arguments: { command: "npm test" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: "/workspace/new.ts", content: "x" } }] },
      { content: "Done." },
    ]);

    const outcome = await runAgentLoop({
      projectId: "p1",
      runId: "r1",
      prompt: "do it",
      workspace,
      nim,
      messages: [{ role: "user", content: "do it" }] as ChatMessage[],
      emit: recordingEmitter().emit,
      budget: new RuntimeBudget(DEFAULT_BUDGET_LIMITS),
      loop: new LoopDetector(),
      previewPort: 3_000,
      recordToolCall: async () => undefined,
    });

    expect(outcome.outcome).toBe("completed");
    // The model client is a script and the runtime is a map, so there is no
    // path from the loop to a billable call: a Sandbox command or a chat
    // completion would have to go through fetch or the injected doubles.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(workspace.execs).toHaveLength(1);
  });
});

describe("the run route cannot cancel its own run", () => {
  /**
   * `registerCancellation` means "the user asked this run to stop" — the loop
   * checks it before its first statement. A route that registered the id it was
   * about to run ended every single task with "Stopped by you." before it did any
   * work, and nothing else in the suite would notice, because the loop is
   * correct and the stop route is correct; only the wiring between them was not.
   */
  const route = read("../src/routes/agent.ts");

  it("never registers the run it is starting as cancelled", () => {
    expect(route).not.toMatch(/registerCancellation\(\s*run\.id\s*\)/);
  });

  it("clears the flag and the watcher when the handler finishes", () => {
    // The `cancelled` set has no sweeper: every producer must be matched by the
    // owner's cleanup or a stopped run leaks an id for the life of the process.
    expect(route).toMatch(/unregisterCancellation\(\s*runId\s*\)/);
    expect(route).toMatch(/res\.removeListener\(\s*"close",\s*onClientGone\s*\)/);
  });

  it("still hands the loop a live cancellation probe", () => {
    expect(route).toMatch(/aborted:\s*\(\)\s*=>\s*isCancelled\(\s*run\.id\s*\)/);
  });
});

describe("a cold read is answered before compute is acquired", () => {
  /**
   * The whole cost argument for the R2 mirror is that browsing a stopped project
   * boots nothing. If a handler ever asks for a workspace first, the mirror stops
   * saving money and starts being a stale second copy that nobody notices —
   * nothing else in the suite fails, because both calls individually work.
   *
   * Asserted against the source because `vi.mock` with a relative specifier does
   * not intercept `src/lib/*` in this vitest setup (only bare package specifiers
   * like `@dai/db` are replaced), so the route cannot be driven with the
   * runtime module stubbed.
   */
  const workspaceRoute = read("../src/routes/workspace.ts");
  const handlers = workspaceRoute
    .split(/(?=^router\.)/m)
    .filter((segment) => segment.startsWith("router.") && segment.includes("await coldMirrorProject"));

  it("has more than one cold-capable handler, so the wiring above is real", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(2);
  });

  it.each(handlers.map((segment) => [segment.split("\n")[0]?.trim().slice(0, 60) ?? "?", segment]))(
    "%s",
    (_label, segment) => {
      const cold = segment.indexOf("coldMirrorProject");
      const compute = segment.indexOf("await workspaceForProject");
      expect(cold).toBeGreaterThan(-1);
      expect(compute, "handler acquires compute without ever consulting the mirror").toBeGreaterThan(-1);
      expect(cold).toBeLessThan(compute);
    }
  );

  it("answers from the mirror and returns, rather than falling through to a sandbox", () => {
    // Every cold branch must exit its handler; one that "falls through to be
    // safe" would boot a machine on every cold read and still look correct.
    for (const segment of handlers) {
      const cold = segment.slice(segment.indexOf("coldMirrorProject"));
      const body = cold.slice(0, cold.indexOf("await workspaceForProject"));
      expect(body).toMatch(/return;/);
    }
  });
});
