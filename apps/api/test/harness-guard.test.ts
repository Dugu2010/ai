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
