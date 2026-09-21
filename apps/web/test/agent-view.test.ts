import { describe, expect, it } from "vitest";
import type { ActivityEvent, ActivityEventType, AgentRun, AgentState, RunStatus } from "@dai/types";
import {
  budgetRows,
  checkpointPathMap,
  deriveRunFacts,
  eventFacts,
  eventMeta,
  isLiveRun,
  outcomeCopy,
  parseActivityEvent,
  parseCheckpointFiles,
  parseRestoreReport,
  stateMeta,
} from "@/lib/agent-view";
import { modelLabel } from "@/lib/format";

/** The 19 types the shared contract defines — kept in sync with the server. */
const EVENT_TYPES: ActivityEventType[] = [
  "agent.started", "agent.status", "agent.file.read", "agent.file.changed", "agent.search",
  "agent.runtime.requested", "agent.runtime.started", "agent.command.started", "agent.command.completed",
  "agent.test.started", "agent.test.completed", "agent.preview.started", "agent.preview.ready",
  "agent.error", "agent.completed", "agent.loop.detected", "agent.undo.created", "agent.undo.restored",
  "agent.budget.exhausted",
];

const STATES: AgentState[] = [
  "queued", "thinking", "inspecting", "searching", "reading", "planning", "editing", "executing",
  "testing", "building", "diagnosing", "fixing", "verifying", "previewing", "completed", "failed",
  "waiting", "paused",
];

function event(type: ActivityEventType, title: string, detail: Record<string, unknown> = {}, seq = 1): ActivityEvent {
  return { id: seq, runId: "run-1", seq, type, state: null, title, detail, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("timeline coverage", () => {
  it("has display metadata for every event type the server can emit", () => {
    for (const type of EVENT_TYPES) {
      const meta = eventMeta(type);
      expect(meta.tone, type).toBeTruthy();
      expect(meta.icon, type).toBeTruthy();
    }
  });

  it("labels every agent state instead of falling back to a blank pill", () => {
    for (const state of STATES) {
      expect(stateMeta(state).label, state).toBeTruthy();
    }
    expect(stateMeta(undefined).label).toBe("Idle");
  });
});

describe("parseActivityEvent", () => {
  it("accepts a well-formed frame", () => {
    const parsed = parseActivityEvent({ seq: 4, type: "agent.command.completed", title: "Ran tests", detail: { exitCode: 0 } });
    expect(parsed?.seq).toBe(4);
    expect(parsed?.type).toBe("agent.command.completed");
  });

  it("rejects frames that are not objects or lack seq/type", () => {
    expect(parseActivityEvent(null)).toBeNull();
    expect(parseActivityEvent("nope" as unknown as Record<string, unknown>)).toBeNull();
    expect(parseActivityEvent({ type: "agent.started" })).toBeNull();
    expect(parseActivityEvent({ seq: 1 })).toBeNull();
  });
});

describe("deriveRunFacts", () => {
  it("aggregates only what really happened", () => {
    const facts = deriveRunFacts([
      event("agent.file.read", "Read file", { path: "/workspace/a.ts" }, 1),
      event("agent.file.changed", "Changed file", { path: "/workspace/b.ts", changeKind: "modify" }, 2),
      event("agent.command.started", "Running tests", { command: "bun test" }, 3),
      event("agent.test.completed", "Tests finished", { failed: 2 }, 4),
      event("agent.error", "Boom", {}, 5),
    ]);
    expect(facts.filesChanged).toEqual(["/workspace/b.ts"]);
    expect(facts.filesRead).toBe(1);
    expect(facts.commands).toBeGreaterThanOrEqual(1);
    expect(facts.failures).toBe(2);
    expect(facts.errors).toBe(1);
  });

  it("drops a path from the changed set once a restore put it back", () => {
    const facts = deriveRunFacts([
      event("agent.file.changed", "Changed file", { path: "/workspace/b.ts", changeKind: "modify" }, 1),
      event("agent.undo.restored", "Reverted", { paths: ["/workspace/b.ts"] }, 2),
    ]);
    expect(facts.filesChanged).toEqual([]);
  });

  it("surfaces the offered recovery choices when the run paused on a loop", () => {
    const facts = deriveRunFacts([
      event("agent.loop.detected", "Repeating the same failing command", {}, 1),
      event("agent.status", "Paused", { choices: ["continue", "retry-differently", "undo"], reason: "loop" }, 2),
    ]);
    expect(facts.pauseChoices).toEqual(["continue", "retry-differently", "undo"]);
    expect(facts.pauseReason).toBe("loop");
  });

  it("reports no choices for a run that never paused", () => {
    expect(deriveRunFacts([event("agent.started", "Started")]).pauseChoices).toEqual([]);
  });

  it("exposes a preview url only when the server sent one", () => {
    expect(deriveRunFacts([event("agent.preview.ready", "Preview ready", { url: "https://x.dev" }, 1)]).previewUrl).toBe(
      "https://x.dev"
    );
    expect(deriveRunFacts([event("agent.preview.started", "Preparing preview", {}, 1)]).previewUrl).toBeNull();
  });
});

describe("eventFacts", () => {
  it("renders observable detail only", () => {
    expect(eventFacts(event("agent.command.completed", "Ran", { command: "bun test", exitCode: 1, durationMs: 1500 }))).toMatch(
      /bun test/
    );
    expect(eventFacts(event("agent.command.completed", "Ran", { exitCode: 1 }))).toMatch(/exit 1/);
    expect(eventFacts(event("agent.search", "Searched", { pattern: "needsRuntime", matches: 3 }))).toMatch(/needsRuntime/);
  });

  it("never surfaces reasoning-looking fields, whatever the server sent", () => {
    // The prompt is never persisted or streamed, so a field shaped like hidden
    // chain of thought must not reach the visible timeline either.
    const leaked = event(
      "agent.status",
      "Thinking",
      { reasoning: "secret plan", thought: "secret", chainOfThought: "secret", thinking: "secret" }
    );
    const rendered = eventFacts(leaked) ?? "";
    expect(rendered).not.toMatch("secret");
  });

  it("returns null when there is nothing factual to show", () => {
    expect(eventFacts(event("agent.started", "Started", {}))).toBeNull();
  });
});

describe("budget accounting", () => {
  const limits = {
    maxActivationsPerRun: 1,
    maxExecCallsPerRun: 12,
    maxRuntimeSecondsPerRun: 300,
    maxAgentIterations: 8,
  } as RunStatus["limits"];

  it("maps real per-run counts onto the meter rows", () => {
    const run = {
      counts: { runtimeActivations: 1, execCalls: 5, runtimeMs: 42_000, iterations: 3 },
    } as unknown as AgentRun;
    const rows = budgetRows(run, limits);
    expect(rows.map((r) => r.key)).toEqual(["activations", "commands", "runtime", "iterations"]);
    expect(rows.find((r) => r.key === "runtime")?.used).toBe(42);
    expect(rows.find((r) => r.key === "commands")?.used).toBe(5);
  });

  it("shows nothing when limits are unknown rather than inventing them", () => {
    expect(budgetRows(null, null)).toEqual([]);
  });
});

describe("restore reports", () => {
  it("keeps partial and blocked results honest", () => {
    const partial = parseRestoreReport({
      status: "partial",
      label: "Run 1",
      checkpointId: "c1",
      results: [{ path: "/workspace/a.ts", status: "restored" }, { path: "/workspace/b.ts", status: "conflict", detail: "changed since" }],
    });
    expect(partial?.status).toBe("partial");
    expect(partial?.results).toHaveLength(2);
    expect(partial?.results[1]?.status).toBe("conflict");

    const blocked = parseRestoreReport({ status: "blocked", message: "Runtime is offline", results: [] });
    expect(blocked?.message).toBe("Runtime is offline");
  });

  it("refuses to invent a report out of junk", () => {
    expect(parseRestoreReport(null)).toBeNull();
    expect(parseRestoreReport({ status: "great success" })).toBeNull();
    expect(parseRestoreReport({})).toBeNull();
  });
});

describe("parseCheckpointFiles", () => {
  it("reads the stored images the diff viewer renders from", () => {
    const files = parseCheckpointFiles({
      checkpoint: {
        files: [
          {
            path: "/workspace/a.ts",
            changeKind: "modify",
            contentBefore: "1\n",
            contentAfter: "2\n",
            existedBefore: true,
            sizeBefore: 2,
            sizeAfter: 2,
            reversible: true,
            skipReason: null,
          },
        ],
      },
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("/workspace/a.ts");
    expect(files[0]?.contentBefore).toBe("1\n");
  });

  it("treats a malformed payload as no files rather than throwing", () => {
    expect(parseCheckpointFiles(null)).toEqual([]);
    expect(parseCheckpointFiles({})).toEqual([]);
    expect(parseCheckpointFiles({ checkpoint: { files: "nope" } })).toEqual([]);
    expect(parseCheckpointFiles({ checkpoint: { files: [{ nope: true }] } })).toEqual([]);
  });
});

describe("checkpoint path map", () => {
  it("attributes the paths written before a checkpoint to that checkpoint", () => {
    const map = checkpointPathMap([
      event("agent.file.changed", "Changed a", { path: "/workspace/a.ts" }, 1),
      event("agent.file.changed", "Changed b", { path: "/workspace/b.ts" }, 2),
      event("agent.undo.created", "Checkpoint created", { checkpointId: "cp1" }, 3),
    ]);
    expect(map.get("cp1")).toEqual(["/workspace/a.ts", "/workspace/b.ts"]);
  });

  it("records nothing for a checkpoint that captured no writes", () => {
    const map = checkpointPathMap([event("agent.undo.created", "Checkpoint created", { checkpointId: "cp1" }, 1)]);
    expect(map.size).toBe(0);
  });
});

describe("run liveness", () => {
  it("is live only while streaming or before the run reaches an outcome", () => {
    expect(isLiveRun({ outcome: "completed" } as unknown as AgentRun, false)).toBe(false);
    expect(isLiveRun({ outcome: null } as unknown as AgentRun, true)).toBe(true);
    expect(isLiveRun(null, false)).toBe(false);
  });

  it("explains a stopped run instead of showing a generic failure", () => {
    const copy = outcomeCopy({ outcome: "cancelled", stopReason: "Stopped by you." } as unknown as AgentRun);
    expect(copy).not.toBeNull();
    expect(copy?.tone).toBeTruthy();
  });
});

describe("model naming", () => {
  it("never prints a raw provider model id", () => {
    const label = modelLabel("meta/llama-3.1-405b-instruct");
    expect(label).not.toContain("meta/");
    expect(label.length).toBeGreaterThan(0);
    expect(modelLabel(undefined)).toBe("Model");
  });
});
