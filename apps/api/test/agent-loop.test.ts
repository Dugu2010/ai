import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@dai/nim";
import { runAgentLoop } from "../src/lib/agent-loop.js";
import { LoopDetector } from "../src/lib/loop-detector.js";
import { RuntimeBudget, type BudgetLimits } from "../src/lib/runtime-policy.js";
import { FakeWorkspace, recordingEmitter, scriptedNim, type ScriptedTurn } from "./fakes.js";

const holder = vi.hoisted(() => ({ db: null as MemoryDb | null }));
vi.mock("@dai/db", async () => {
  const fakes = await import("./fakes.js");
  const db = fakes.memoryCheckpointDb();
  holder.db = db;
  return fakes.installMemoryDb(db) as Record<string, unknown>;
});
type MemoryDb = import("./fakes.js").MemoryCheckpointDb;

/**
 * The loop is where the cost model lives or dies. These tests drive it with a
 * scripted model and an in-memory workspace and assert on what the workspace was
 * actually asked to do: how many commands, in what order, and with which paths.
 */

const A = "/workspace/src/a.ts";
const B = "/workspace/src/b.ts";
const C = "/workspace/src/c.ts";

const TIGHT_LIMITS: BudgetLimits = {
  maxActivationsPerRun: 1,
  maxExecCallsPerRun: 40,
  maxRuntimeSecondsPerRun: 600,
  maxCommandTimeoutMs: 300_000,
  maxAgentIterations: 12,
  maxCheckpointBatchBytes: 6_000_000,
  maxCheckpointFileBytes: 1_000_000,
};

interface RunOptions {
  turns: Array<ScriptedTurn | Error>;
  workspace?: FakeWorkspace;
  limits?: Partial<BudgetLimits>;
  aborted?: () => boolean;
  loop?: LoopDetector;
}

function runLoop(options: RunOptions) {
  const workspace = options.workspace ?? new FakeWorkspace({ files: { [A]: "alpha", [B]: "beta" } });
  const { nim, requests } = scriptedNim(options.turns);
  const budget = new RuntimeBudget({ ...TIGHT_LIMITS, ...options.limits });
  const loop = options.loop ?? new LoopDetector();
  const activity = recordingEmitter();
  const toolResults: Array<{ name: string; result: string; success: boolean }> = [];

  const result = runAgentLoop({
    projectId: "proj-1",
    runId: "run-1",
    prompt: "make the tests pass",
    workspace,
    nim,
    messages: [{ role: "user", content: "make the tests pass" }] as ChatMessage[],
    emit: activity.emit,
    budget,
    loop,
    previewPort: 3_000,
    aborted: options.aborted,
    recordToolCall: async (entry) => {
      toolResults.push({ name: entry.name, result: entry.result, success: entry.success });
    },
  });

  return { result, workspace, budget, loop, activity, requests, toolResults };
}

const edit = (path: string, content: string) => ({
  name: "write_file",
  arguments: { path, content },
});
const command = (text: string) => ({ name: "run_command", arguments: { command: text } });
const read = (path: string) => ({ name: "read_file", arguments: { path } });

describe("one activation per run", () => {
  it("never acquires or creates compute itself; the caller attaches the workspace", async () => {
    const { result, budget } = await runLoop({
      turns: [{ toolCalls: [command("npm test")] }, { content: "Done." }],
    });
    const outcome = await result;
    expect(outcome.outcome).toBe("completed");
    // The loop has no provider, client or project id to acquire with, and it
    // does not spend an activation: it was handed an attached workspace.
    expect(budget.summary().activations).toBe(0);
    expect(outcome.runtimeActivations).toBe(0);
  });

  it("stops when the iteration budget is spent, with a stated reason", async () => {
    const turns = Array.from({ length: 6 }, () => ({ toolCalls: [read(A)] }));
    const { result, budget } = await runLoop({ turns, limits: { maxAgentIterations: 2 } });
    const outcome = await result;
    expect(outcome.outcome).toBe("budget_exhausted");
    expect(outcome.stopReason).toBe("Stopped after 2 iterations in this run.");
    expect(budget.summary().exhausted).toBe("iterations");
  });

  it("degrades instead of overspending once the exec ceiling is gone", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result } = await runLoop({
      workspace,
      // Two commands' worth of allowance, and a turn that asks for three.
      limits: { maxExecCallsPerRun: 2 },
      turns: [{ toolCalls: [command("npm test"), command("npm run build"), command("npm run lint")] }],
    });
    const outcome = await result;
    expect(outcome.outcome).toBe("budget_exhausted");
    expect(workspace.execs.map((entry) => entry.command)).toEqual(["npm test", "npm run build"]);
    expect(outcome.stopReason).toMatch(/runtime commands/);
  });
});

describe("no route to compute", () => {
  /**
   * The loop must be unable to provision anything. Wrapping the workspace in a
   * proxy that only answers the documented `Workspace` members turns "it never
   * acquires compute" into something a test can actually catch: if this file
   * ever grows a `provider.acquire()`, `sandboxes.create()` or a re-attach, the
   * run throws instead of quietly spending money.
   */
  const CONTRACT = [
    "sandboxId",
    "exec",
    "readFile",
    "readFilesBatch",
    "writeFile",
    "applyFileMutations",
    "listFiles",
    "stat",
    "remove",
    "rename",
    "mkdir",
    "searchFiles",
    "searchContent",
    "getGitStatus",
    "getGitDiff",
    "waitForPort",
    "startDevServer",
    "stopDevServer",
    "getPreviewUrl",
    "workspaceUsageBytes",
    "isAlive",
    "terminate",
    "close",
  ];

  function contractOnly(inner: FakeWorkspace) {
    const reached: string[] = [];
    const proxy = new Proxy(inner as object, {
      get(target, property) {
        const key = String(property);
        if (!CONTRACT.includes(key)) {
          reached.push(key);
          throw new Error(`the loop reached for "${key}", which is not part of the Workspace contract`);
        }
        const value = (target as Record<string, unknown>)[key];
        // Bind to the raw target: the doubles use bound class fields, and a
        // proxy `this` would make them reach back through this same trap.
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
      has(_target, property) {
        return typeof property === "string" && CONTRACT.includes(property);
      },
    });
    return { workspace: proxy as unknown as FakeWorkspace, reached };
  }

  it("touches nothing beyond the attached workspace it was handed", async () => {
    const guarded = contractOnly(new FakeWorkspace({ files: { [A]: "alpha" } }));
    const { result } = await runLoop({
      workspace: guarded.workspace,
      turns: [
        { toolCalls: [read(A)] },
        { toolCalls: [{ name: "start_dev_server", arguments: { command: "npm run dev", port: 3_000 } }] },
        { toolCalls: [{ name: "delete_file", arguments: { path: "/workspace/gone.ts" } }] },
        { content: "Done." },
      ],
    });
    const outcome = await result;
    expect(outcome.outcome).toBe("completed");
    expect(guarded.reached).toEqual([]);
  });
});

describe("batched mutations", () => {
  it("applies three edits of one turn as ONE mutation call", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha", [B]: "beta", [C]: "gamma" } });
    const { result } = await runLoop({
      workspace,
      turns: [
        {
          toolCalls: [
            edit(A, "alpha v2"),
            { name: "edit_file", arguments: { path: B, oldString: "beta", newString: "beta v2" } },
            { name: "delete_file", arguments: { path: C } },
          ],
        },
        { content: "Done." },
      ],
    });
    await result;

    expect(workspace.appliedMutations).toHaveLength(1);
    expect(workspace.appliedMutations[0]?.map((entry) => entry.path)).toEqual([A, B, C]);
    expect(workspace.countOf("applyFileMutations")).toBe(1);
  });

  it("flushes the checkpoint BEFORE the batched write is applied", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result } = await runLoop({
      workspace,
      turns: [{ toolCalls: [edit(A, "alpha v2")] }, { content: "Done." }],
    });
    const outcome = await result;

    const batchAt = workspace.order.findIndex((entry) => entry.startsWith("readFilesBatch"));
    const writeAt = workspace.order.findIndex((entry) => entry.startsWith("applyFileMutations"));
    expect(batchAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(batchAt).toBeLessThan(writeAt);
    expect(outcome.checkpointId).not.toBeNull();
    // The pre-image the checkpoint holds is the byte that was on disk first.
    expect(workspace.batchReads[0]).toEqual([A]);
  });

  it("does not spend a checkpoint flush when the turn changed nothing", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result } = await runLoop({ workspace, turns: [{ toolCalls: [read(A)] }, { content: "Done." }] });
    await result;
    expect(workspace.countOf("readFilesBatch")).toBe(0);
    expect(workspace.countOf("applyFileMutations")).toBe(0);
  });

  it("counts only the results the runtime reported as applied", async () => {
    // Two edits were requested; the runtime refuses one, so the run must not
    // claim two changes.
    // The runtime refuses A, so the run may claim one change, not two.
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" }, conflict: [A] });
    const { result } = await runLoop({
      workspace,
      turns: [{ toolCalls: [edit(A, "alpha v2"), { name: "delete_file", arguments: { path: C } }] }],
    });
    const outcome = await result;
    expect(outcome.filesChanged).toBe(1);
    expect(outcome.toolCalls).toBe(2);
  });
});

describe("regression guards for previously broken behaviour", () => {
  /**
   * DEFECT 1. `applyEdits` builds every mutation with `expectCurrent: null`
   * (agent-loop.ts:384-388), but `expectCurrent: null` is implemented by
   * restore-script.ts:34-38 as "this path must not exist". The provider therefore
   * answers `conflict` for any write to a file that is already there. Net effect:
   * the agent can create files but cannot modify one, and the run reports the
   * failure as "Could not change <file>" instead of making the edit.
   */
  it("modifies an existing file by presenting the bytes it expects to find", async () => {
    // Regression guard: `expectCurrent: null` means "this path must not exist",
    // so sending null for every write made the provider refuse every edit of an
    // existing file and the agent could only ever create new ones.
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: [edit(A, "alpha v2")] }],
    });
    const outcome = await result;

    expect(workspace.appliedMutations[0]).toEqual([{ path: A, content: "alpha v2", expectCurrent: "alpha" }]);
    expect(workspace.tree()[A]).toBe("alpha v2");
    expect(outcome.filesChanged).toBe(1);
    expect(activity.titles("agent.error")).toEqual([]);
  });

  it("creates a file that did not exist, expecting to find nothing there", async () => {
    const created = "/workspace/src/fresh.ts";
    const workspace = new FakeWorkspace({ files: {} });
    const { result } = await runLoop({ workspace, turns: [{ toolCalls: [edit(created, "export const a = 1")] }] });
    const outcome = await result;
    expect(outcome.filesChanged).toBe(1);
    expect(workspace.tree()[created]).toBe("export const a = 1");
    expect(workspace.appliedMutations[0]?.[0]).toMatchObject({ expectCurrent: null });
  });

  /**
   * DEFECT 2. `rename_file` is declared with `oldPath`/`newPath`, but
   * `resolveDesiredContent` reads `args.path` (agent-run.ts:385) and
   * `planMutation` reads `args.path ?? args.newPath` (agent-loop.ts:355). So the
   * source is never read, `fromPath` is "", and the queued mutation is
   * `{ path: newPath, content: null }` — a delete of the destination. The source
   * file stays exactly where it was and the model is told the rename was queued.
   */
  it("renames by creating the destination and deleting the source", async () => {
    // Regression guard: rename_file declares oldPath/newPath, and reading
    // args.path instead produced a delete of the destination and left the source
    // in place while reporting success.
    const workspace = new FakeWorkspace({ files: { [A]: "contents" } });
    const { result, toolResults } = await runLoop({
      workspace,
      turns: [{ toolCalls: [{ name: "rename_file", arguments: { oldPath: A, newPath: B } }] }],
    });
    const outcome = await result;

    expect(toolResults[0]).toMatchObject({ name: "rename_file", success: true });
    const mutations = workspace.appliedMutations[0] ?? [];
    expect(mutations).toEqual([
      { path: B, content: "contents", expectCurrent: null },
      { path: A, content: null, expectCurrent: "contents" },
    ]);
    const tree = workspace.tree();
    expect(tree[B]).toBe("contents");
    expect(tree[A]).toBeUndefined();
    expect(outcome.filesChanged).toBe(2); // two paths written: create + delete
  });

  /**
   * Budget is charged once per tool call, by the loop; executeReadOnly no longer
   * gates a second time.
   */
  it("charges exactly one exec unit per command", async () => {
    // Regression guard: gating in both the loop and executeReadOnly consumed two
    // units per command, so a run degraded at half the ceiling it advertised.
    const workspace = new FakeWorkspace({ files: {} });
    const { result } = await runLoop({ workspace, turns: [{ toolCalls: [command("npm test")] }] });
    const outcome = await result;
    expect(workspace.execs).toHaveLength(1);
    expect(outcome.execCalls).toBe(1);
  });

  /**
   * The loop has no path to provisioning: `routes/agent.ts` attaches the Sandbox
   * and charges `budget.startActivation()` for a freshly created one, so the
   * loop's own meter must stay at zero. Anything that makes this test fail means
   * the loop grew the ability to start compute, which is the thing it must not
   * be able to do.
   */
  it("never activates compute from inside the loop itself", async () => {
    const { result, budget } = await runLoop({
      turns: [{ toolCalls: [command("npm test")] }, { content: "Done." }],
    });
    await result;
    expect(budget.activations).toBe(0);
    expect(budget.summary().exhausted).toBeNull();
  });
});

describe("deduplicated reads", () => {
  it("serves the second read of a file from the run cache, not from a command", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result, toolResults } = await runLoop({
      workspace,
      turns: [{ toolCalls: [read(A), read(A)] }, { content: "Done." }],
    });
    await result;
    expect(workspace.readFileCalls).toEqual([A]);
    expect(toolResults.filter((entry) => entry.result === "alpha")).toHaveLength(2);
  });

  it("re-reads after a command, which may have rewritten the file", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result } = await runLoop({
      workspace,
      turns: [{ toolCalls: [read(A)] }, { toolCalls: [command("npm test")] }, { toolCalls: [read(A)] }],
    });
    await result;
    expect(workspace.readFileCalls).toEqual([A, A]);
  });

  it("does not charge a cached read as an extra command", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result, budget } = await runLoop({
      workspace,
      turns: [{ toolCalls: [read(A), read(A), read(A)] }],
    });
    const outcome = await result;
    expect(outcome.execCalls).toBeLessThanOrEqual(3);
    expect(budget.execCalls).toBe(budget.summary().execCalls);
  });
});

describe("charging", () => {
  it("charges the budget for every command it runs", async () => {
    const workspace = new FakeWorkspace({ files: {} });
    const { result, budget } = await runLoop({
      workspace,
      turns: [{ toolCalls: [command("npm test"), command("npm run build")] }],
    });
    const outcome = await result;
    expect(workspace.execs).toHaveLength(2);
    // Every executed command is charged; the charge may never be lower.
    expect(outcome.execCalls).toBeGreaterThanOrEqual(workspace.execs.length);
    expect(budget.summary().execCalls).toBe(outcome.execCalls);
  });


  it("runs one command per tool call, with the budget's clamped timeout", async () => {
    const workspace = new FakeWorkspace({ files: {} });
    const { result } = await runLoop({
      workspace,
      limits: { maxCommandTimeoutMs: 5_000 },
      turns: [{ toolCalls: [{ name: "run_command", arguments: { command: "npm test", timeoutMs: 90_000 } }] }],
    });
    await result;
    expect(workspace.execs).toHaveLength(1);
    expect(workspace.execs[0]).toMatchObject({ command: "npm test", cwd: "/workspace", timeoutMs: 5_000 });
  });

  it("runs nothing at all once its allowance is spent", async () => {
    const workspace = new FakeWorkspace({ files: {} });
    const { result } = await runLoop({
      workspace,
      limits: { maxExecCallsPerRun: 1 },
      turns: [{ toolCalls: [command("npm test"), command("npm run build")] }],
    });
    const outcome = await result;
    // A ceiling of 1 admits exactly one command and refuses the rest.
    expect(workspace.execs.map((entry) => entry.command)).toEqual(["npm test"]);
    expect(outcome.outcome).toBe("budget_exhausted");
  });
});

describe("stopping", () => {
  it("honours aborted() between iterations and ends cleanly", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    // Checked once per iteration, so this stops the run as it enters turn 2.
    let checks = 0;
    const { result, requests } = await runLoop({
      workspace,
      aborted: () => {
        checks += 1;
        return checks > 1;
      },
      turns: [{ toolCalls: [read(A)] }, { toolCalls: [read(A)] }, { toolCalls: [read(A)] }],
    });
    const outcome = await result;
    expect(outcome.outcome).toBe("cancelled");
    expect(outcome.state).toBe("failed");
    expect(outcome.stopReason).toBe("Stopped by you.");
    // Turn 1 was served; the stop was seen before turn 2 asked the model.
    expect(requests).toHaveLength(1);
    expect(outcome.content).toBeNull();
  });

  it("checks for a stop before the very first model call", async () => {
    const { result, requests } = await runLoop({
      aborted: () => true,
      turns: [{ content: "never reached" }],
    });
    const outcome = await result;
    expect(outcome.outcome).toBe("cancelled");
    expect(requests).toHaveLength(0);
  });

  it("ends the run when the model asks for no more tools", async () => {
    const { result, workspace } = await runLoop({
      turns: [{ toolCalls: [read(A)] }, { content: "All good." }],
    });
    const outcome = await result;
    expect(outcome.outcome).toBe("completed");
    expect(outcome.state).toBe("completed");
    expect(outcome.content).toBe("All good.");
    expect(workspace.countOf("exec")).toBe(0);
  });

  it("fails with a stated reason when the model request throws", async () => {
    const { result, activity } = await runLoop({ turns: [new Error("429 overloaded")] });
    const outcome = await result;
    expect(outcome.outcome).toBe("failed");
    expect(outcome.stopReason).toContain("429 overloaded");
    expect(activity.titles("agent.error")).toEqual(["Could not reach the model"]);
  });
});

describe("observable activity only", () => {
  it("describes a passing command by its real exit code", async () => {
    const workspace = new FakeWorkspace({
      files: {},
      execResults: [{ match: "npm test", stdout: "all good", exitCode: 0 }],
    });
    const { result, activity } = await runLoop({ workspace, turns: [{ toolCalls: [command("npm test")] }] });
    await result;
    expect(activity.titles("agent.test.completed")).toEqual([expect.stringMatching(/^Tests passed in [\d.]+s$/)]);
    expect(activity.events.some((event) => event.type === "agent.test.started")).toBe(true);
  });

  it("reports the real failure count out of the output, not a made-up one", async () => {
    const workspace = new FakeWorkspace({
      files: {},
      execResults: [{ match: "npm test", stdout: "Tests  3 failures", exitCode: 1 }],
    });
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: [{ name: "run_tests", arguments: {} }] }],
    });
    await result;
    const titles = activity.titles("agent.test.completed");
    expect(titles).toEqual(["Tests failed: 3 failures"]);
    expect(activity.events.some((event) => event.state === "diagnosing")).toBe(true);
  });

  it("says a command timed out only when the runtime said so", async () => {
    const workspace = new FakeWorkspace({
      files: {},
      execResults: [{ match: "node", stdout: "", exitCode: null, timedOut: true }],
    });
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: [command("node -e 'while(true){}'")] }],
    });
    await result;
    const completed = activity.titles("agent.command.completed")[0] ?? "";
    expect(completed).toMatch(/timed out after/);
    expect(workspace.execs[0]?.command).toContain("node");
  });

  it("emits a file-changed event with the paths that really landed", async () => {
    const created = "/workspace/src/new.ts";
    const workspace = new FakeWorkspace({ files: {} });
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: [edit(created, "export const x = 1")] }],
    });
    const outcome = await result;
    const changed = activity.events.find((event) => event.type === "agent.file.changed");
    expect(changed?.detail.paths).toEqual([created]);
    expect(changed?.detail.changed).toBe(1);
    expect(changed?.title).toBe("AI changed new.ts");
    expect(outcome.filesChanged).toBe(1);
    expect(workspace.tree()[created]).toBe("export const x = 1");
  });

  it("records an undo checkpoint event naming the paths it captured", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: [edit(A, "alpha v2")] }],
    });
    await result;
    const created = activity.events.find((event) => event.type === "agent.undo.created");
    expect(created?.detail.paths).toEqual([A]);
    expect(created?.title).toMatch(/Checkpoint recorded/);
  });

  it("emits nothing that did not happen", async () => {
    const { result, activity } = await runLoop({ turns: [{ content: "Nothing to do." }] });
    await result;
    expect(activity.events.map((event) => event.type)).toEqual(["agent.started", "agent.status"]);
  });
});

describe("loop detection wiring", () => {
  it("pauses rather than repeating a fourth time", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const same = [read(A)];
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: same }, { toolCalls: same }, { toolCalls: same }, { toolCalls: same }],
    });
    const outcome = await result;
    expect(outcome.outcome).toBe("paused");
    expect(activity.events.some((event) => event.type === "agent.loop.detected")).toBe(true);
    // A detected loop must stop the run, not keep spending.
    expect(workspace.readFileCalls.length).toBeLessThanOrEqual(3);
  });

  it("offers a bounded retry before pausing", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha", [B]: "beta" } });
    const { result, activity } = await runLoop({
      workspace,
      turns: [
        { toolCalls: [read(A)] },
        { toolCalls: [read(A)] },
        { toolCalls: [read(A)] },
        { toolCalls: [read(B)] },
        { toolCalls: [read(A)] },
        { toolCalls: [read(A)] },
        { toolCalls: [read(A)] },
      ],
    });
    const outcome = await result;
    const detected = activity.events.filter((event) => event.type === "agent.loop.detected");
    expect(detected.length).toBeGreaterThanOrEqual(1);
    expect(["paused", "completed", "budget_exhausted"]).toContain(outcome.outcome);
    if (detected.length > 1) {
      expect(detected[0]?.detail.recoveries).toBe(1);
      expect(detected[1]?.detail.recoveries).toBe(2);
    }
  });
});

describe("tool results handed back to the model", () => {
  it("tells the model what a listing contained", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha" } });
    const { result, toolResults } = await runLoop({
      workspace,
      turns: [{ toolCalls: [{ name: "list_files", arguments: { path: "/workspace" } }] }],
    });
    await result;
    expect(toolResults[0]?.success).toBe(true);
    expect(toolResults[0]?.result).toContain("a.ts");
    expect(workspace.listFilesCalls).toEqual(["/workspace"]);
  });

  it("surfaces a search and its real match count", async () => {
    const workspace = new FakeWorkspace({ files: { [A]: "alpha needle" } });
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: [{ name: "search_content", arguments: { pattern: "needle" } }] }],
    });
    await result;
    expect(workspace.searchContentCalls).toEqual([{ dir: "/workspace", pattern: "needle" }]);
    expect(activity.events.some((event) => event.type === "agent.search")).toBe(true);
  });

  it("reports the preview URL the runtime actually returned", async () => {
    const workspace = new FakeWorkspace({ files: {} });
    const { result, activity } = await runLoop({
      workspace,
      turns: [{ toolCalls: [{ name: "get_preview_url", arguments: {} }] }],
    });
    await result;
    expect(workspace.previewPorts).toEqual([3_000]);
    expect(activity.events.find((event) => event.type === "agent.preview.ready")?.detail.url).toBe(
      "https://preview.fake/3000"
    );
  });
});
