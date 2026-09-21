import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BUDGET_LIMITS,
  RuntimeBudget,
  budgetSnapshotForStorage,
  needsRuntime,
  type RuntimeOperation,
} from "../src/lib/runtime-policy.js";

/**
 * Every member of the `RuntimeOperation` union, listed by hand so that widening
 * the union without classifying it fails here rather than silently defaulting.
 */
const ALL_OPERATIONS: RuntimeOperation[] = [
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.delete",
  "fs.rename",
  "fs.search",
  "command.exec",
  "dev_server.start",
  "preview.url",
  "git.status",
  "git.diff",
  "checkpoint.restore",
];

function limits(overrides: Partial<typeof DEFAULT_BUDGET_LIMITS>) {
  return { ...DEFAULT_BUDGET_LIMITS, ...overrides };
}

describe("needsRuntime classification", () => {
  it("classifies every operation in the union", () => {
    for (const operation of ALL_OPERATIONS) {
      const decision = needsRuntime(operation);
      expect(decision.operation).toBe(operation);
      expect(["free", "runtime"]).toContain(decision.cost);
      expect(decision.reason.length).toBeGreaterThan(10);
    }
  });

  it("says workspace and command operations cost compute", () => {
    for (const operation of ALL_OPERATIONS) {
      if (operation === "preview.url") continue;
      const decision = needsRuntime(operation);
      expect(decision.cost).toBe("runtime");
      expect(decision.requiresRuntime).toBe(true);
      // The rationale is a provider fact, and it is surfaced verbatim to the
      // user, so it must name the reason rather than shrug.
      expect(decision.reason).toMatch(/Volume|Sandbox/);
    }
  });

  it("treats a preview token as free of commands even though it needs an attached Sandbox", () => {
    const decision = needsRuntime("preview.url");
    // `cost: "free"` means "consumes no exec and no activation". The token still
    // comes from a live Sandbox handle, so requiresRuntime stays true: a free
    // operation must never be reported as runnable with no compute attached.
    expect(decision.cost).toBe("free");
    expect(decision.requiresRuntime).toBe(true);
    expect(decision.reason).toMatch(/control plane/);
  });

  it("never marks checkpoint restore as free, despite the docs listing it as Postgres-side", () => {
    // Undo is one batched command, so it is charged like any other write. This
    // pins the classification against someone "optimising" it to free.
    expect(needsRuntime("checkpoint.restore").cost).toBe("runtime");
    expect(needsRuntime("fs.read").cost).toBe("runtime");
  });

  it("does not mark anything degraded by default", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(needsRuntime(operation).degraded).toBeUndefined();
    }
  });
});

describe("activation gate", () => {
  it("blocks a second activation of the same run", () => {
    const budget = new RuntimeBudget(limits({ maxActivationsPerRun: 1 }));
    expect(budget.startActivation().ok).toBe(true);
    const second = budget.startActivation();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/activation limit/i);
    // Rejected activations are not counted, so the record stays honest.
    expect(budget.activations).toBe(1);
  });

  it("allows the number of activations it was configured with", () => {
    const budget = new RuntimeBudget(limits({ maxActivationsPerRun: 3 }));
    for (let attempt = 0; attempt < 3; attempt += 1) expect(budget.startActivation().ok).toBe(true);
    expect(budget.startActivation().ok).toBe(false);
    expect(budget.activations).toBe(3);
  });

  it("allows nothing when the run is given a zero activation allowance", () => {
    const budget = new RuntimeBudget(limits({ maxActivationsPerRun: 0 }));
    expect(budget.startActivation().ok).toBe(false);
    expect(budget.activations).toBe(0);
  });
});

describe("exec and runtime-seconds ceilings", () => {
  it("exhausts on the exec-call ceiling and names it", () => {
    const budget = new RuntimeBudget(limits({ maxExecCallsPerRun: 2 }));
    expect(budget.startExec().ok).toBe(true);
    expect(budget.startExec().ok).toBe(true);
    expect(budget.exhausted).toBe("exec_calls");
    const blocked = budget.startExec();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message).toMatch(/Exec-call budget exhausted/);
    expect(budget.summary().exhausted).toBe("exec_calls");
    expect(budget.execCalls).toBe(2);
  });

  it("exhausts on wall-clock runtime and names that instead", () => {
    const budget = new RuntimeBudget(limits({ maxRuntimeSecondsPerRun: 5, maxExecCallsPerRun: 1_000 }));
    budget.recordRuntimeMs(5_000);
    expect(budget.exhausted).toBe("runtime_seconds");
    const blocked = budget.startExec();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message).toMatch(/Runtime wall-clock budget exhausted \(5s/);
  });

  it("reports exec_calls before runtime_seconds when both are spent", () => {
    const budget = new RuntimeBudget(limits({ maxExecCallsPerRun: 1, maxRuntimeSecondsPerRun: 1 }));
    budget.startExec();
    budget.recordRuntimeMs(10_000);
    expect(budget.exhausted).toBe("exec_calls");
  });

  it("keeps one spend counter per charged call, so a run can be audited", () => {
    const budget = new RuntimeBudget(limits({ maxExecCallsPerRun: 10 }));
    budget.startExec();
    budget.startExec();
    budget.recordRuntimeMs(1_234);
    budget.recordRuntimeMs(-500);
    const summary = budget.summary();
    expect(summary.execCalls).toBe(2);
    expect(summary.runtimeMs).toBe(1_234);
    expect(summary.limits.maxExecCallsPerRun).toBe(10);
  });

  it("ignores negative runtime recordings", () => {
    const budget = new RuntimeBudget();
    budget.recordRuntimeMs(-10);
    expect(budget.runtimeMs).toBe(0);
  });
});

describe("iteration accounting", () => {
  it("charges iterations and refuses past the ceiling", () => {
    const budget = new RuntimeBudget(limits({ maxAgentIterations: 2 }));
    expect(budget.useIteration()).toBe(true);
    expect(budget.useIteration()).toBe(true);
    expect(budget.useIteration()).toBe(false);
    expect(budget.iterations).toBe(2);
    expect(budget.exhausted).toBe("iterations");
    const blocked = budget.startExec();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.message).toMatch(/Iteration budget exhausted/);
  });

  it("never reports negative remaining iterations", () => {
    const budget = new RuntimeBudget(limits({ maxAgentIterations: 1 }));
    budget.useIteration();
    expect(budget.iterationsRemaining).toBe(0);
    // Even a wildly over-limit counter must not produce a negative allowance.
    budget.iterations = 500;
    expect(budget.iterationsRemaining).toBe(0);
    expect(budget.summary().iterationsRemaining).toBe(0);
  });

  it("counts down as iterations are spent", () => {
    const budget = new RuntimeBudget(limits({ maxAgentIterations: 4 }));
    expect(budget.iterationsRemaining).toBe(4);
    budget.useIteration();
    expect(budget.iterationsRemaining).toBe(3);
  });
});

describe("command timeout clamping", () => {
  const budget = new RuntimeBudget(limits({ maxCommandTimeoutMs: 30_000 }));

  it("caps a requested timeout at the ceiling", () => {
    expect(budget.commandTimeoutMs(120_000)).toBe(30_000);
  });

  it("keeps a shorter requested timeout", () => {
    expect(budget.commandTimeoutMs(4_000)).toBe(4_000);
  });

  it("defaults to the ceiling when nothing is requested", () => {
    expect(budget.commandTimeoutMs()).toBe(30_000);
    expect(budget.commandTimeoutMs(0)).toBe(30_000);
    expect(budget.commandTimeoutMs(Number.NaN)).toBe(30_000);
    expect(budget.commandTimeoutMs(Number.POSITIVE_INFINITY)).toBe(30_000);
  });

  it("never lets a command run for less than a second, and floors fractions", () => {
    expect(budget.commandTimeoutMs(1)).toBe(1_000);
    expect(budget.commandTimeoutMs(4_500.7)).toBe(4_500);
  });

  it("clamps to a configured ceiling rather than a hardcoded one", () => {
    const tight = new RuntimeBudget(limits({ maxCommandTimeoutMs: 2_000 }));
    expect(tight.commandTimeoutMs(60_000)).toBe(2_000);
  });
});

describe("configurable limits (why CI cannot spend credits)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads a tightened exec ceiling from the environment", async () => {
    vi.stubEnv("MAX_EXEC_CALLS_PER_AGENT_RUN", "3");
    vi.stubEnv("MAX_AGENT_ITERATIONS", "2");
    vi.stubEnv("MAX_RUNTIME_SECONDS_PER_AGENT_RUN", "30");
    vi.resetModules();
    const mod = await import("../src/lib/runtime-policy.js");
    expect(mod.DEFAULT_BUDGET_LIMITS.maxExecCallsPerRun).toBe(3);
    expect(mod.DEFAULT_BUDGET_LIMITS.maxAgentIterations).toBe(2);
    expect(mod.DEFAULT_BUDGET_LIMITS.maxRuntimeSecondsPerRun).toBe(30);

    // A budget built from those limits stops the run after three commands.
    const budget = new mod.RuntimeBudget(mod.DEFAULT_BUDGET_LIMITS);
    expect(budget.startExec().ok).toBe(true);
    expect(budget.startExec().ok).toBe(true);
    expect(budget.startExec().ok).toBe(true);
    expect(budget.startExec().ok).toBe(false);
  });

  it("falls back to the shipped default when the override is not a positive integer", async () => {
    vi.stubEnv("MAX_EXEC_CALLS_PER_AGENT_RUN", "0");
    vi.stubEnv("MAX_AGENT_ITERATIONS", "not-a-number");
    vi.resetModules();
    const mod = await import("../src/lib/runtime-policy.js");
    expect(mod.DEFAULT_BUDGET_LIMITS.maxExecCallsPerRun).toBe(40);
    expect(mod.DEFAULT_BUDGET_LIMITS.maxAgentIterations).toBe(12);
  });

  it("keeps every shipped default finite and positive, so no ceiling is 'unbounded'", () => {
    for (const [name, value] of Object.entries(DEFAULT_BUDGET_LIMITS)) {
      expect(Number.isFinite(value), name).toBe(true);
      expect(value, name).toBeGreaterThan(0);
    }
    // One activation per run is the whole cost argument; pin it.
    expect(DEFAULT_BUDGET_LIMITS.maxActivationsPerRun).toBe(1);
  });
});

describe("budget record", () => {
  it("serialises exactly the summary for agent_runs.budget_json", () => {
    const budget = new RuntimeBudget(limits({ maxAgentIterations: 3 }));
    budget.startActivation();
    budget.startExec();
    budget.useIteration();
    budget.recordRuntimeMs(2_500);
    const snapshot = budgetSnapshotForStorage(budget);
    expect(snapshot).toEqual(budget.summary());
    expect(snapshot).toMatchObject({
      activations: 1,
      execCalls: 1,
      iterations: 1,
      runtimeMs: 2_500,
      iterationsRemaining: 2,
      exhausted: null,
    });
  });
});
