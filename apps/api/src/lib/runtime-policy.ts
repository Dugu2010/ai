/**
 * Runtime policy: which operations need Modal compute, and how much a single
 * agent run is allowed to spend.
 *
 * Why file operations are classified as requiring compute — this is a provider
 * fact, verified against modal@0.10.1's shipped declarations, not a choice:
 *
 *   class Volume { volumeId; name; withMountOptions(); closeEphemeral(); }
 *   class VolumeService { fromName(); ephemeral(); delete(); }
 *
 * The JavaScript SDK exposes no read/list/write API on a Volume: a Volume can
 * only be touched through a mounted filesystem. `SandboxFilesystem`'s own
 * constructor takes an `exec` function, i.e. the "filesystem" API is sugar over
 * commands running inside a Sandbox. There is therefore no cheaper non-runtime
 * path for workspace bytes, and pretending otherwise would be a fake.
 *
 * What *is* free, and served from Postgres instead of compute:
 *   - project and runtime metadata
 *   - conversation and activity history
 *   - checkpoint pre/post-images and therefore diffs, undo and redo
 * The optimization actually available is: never activate compute more than once
 * per run, reuse the live Sandbox for every operation, batch multi-file work
 * into a single command, and degrade loudly when the budget runs out.
 */

export type RuntimeOperation =
  | "fs.list"
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "fs.rename"
  | "fs.search"
  | "command.exec"
  | "dev_server.start"
  | "preview.url"
  | "git.status"
  | "git.diff"
  | "checkpoint.restore";

export type CostClass = "free" | "runtime";

export interface RuntimeDecision {
  operation: RuntimeOperation;
  cost: CostClass;
  requiresRuntime: boolean;
  /** Human-readable, and surfaced verbatim in the activity timeline. */
  reason: string;
  /** Set when the operation is degraded rather than executed. */
  degraded?: boolean;
}

/**
 * Operations that never touch workspace bytes are answered from Postgres, so
 * they are free. Everything that reads or writes project files needs the
 * mounted Volume, and therefore a live Sandbox.
 */
const RUNTIME_REASONS: Partial<Record<RuntimeOperation, string>> = {
  "preview.url": "Tunnel tokens come from the control plane, so they cost no command.",
};

export function needsRuntime(operation: RuntimeOperation): RuntimeDecision {
  if (operation === "preview.url") {
    return {
      operation,
      // A token is a control-plane call rather than workspace I/O: it still
      // needs an attached Sandbox, but it consumes no command and no activation.
      cost: "free",
      requiresRuntime: true,
      reason: RUNTIME_REASONS[operation]!,
    };
  }
  return {
    operation,
    cost: "runtime",
    requiresRuntime: true,
    reason:
      "Modal exposes no file API on a Volume; workspace bytes are only reachable through a mounted Sandbox.",
  };
}

export interface BudgetLimits {
  maxActivationsPerRun: number;
  maxExecCallsPerRun: number;
  maxRuntimeSecondsPerRun: number;
  maxCommandTimeoutMs: number;
  maxAgentIterations: number;
  /** Ceiling on one multi-file restore command, to keep it to a single exec. */
  maxCheckpointBatchBytes: number;
  /** Files above this size are not recorded, so undo declines rather than half-restores. */
  maxCheckpointFileBytes: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxActivationsPerRun: intEnv("MAX_RUNTIME_ACTIVATIONS_PER_AGENT_RUN", 1),
  maxExecCallsPerRun: intEnv("MAX_EXEC_CALLS_PER_AGENT_RUN", 40),
  maxRuntimeSecondsPerRun: intEnv("MAX_RUNTIME_SECONDS_PER_AGENT_RUN", 600),
  maxCommandTimeoutMs: intEnv("MAX_COMMAND_TIMEOUT", 300_000),
  maxAgentIterations: intEnv("MAX_AGENT_ITERATIONS", 12),
  maxCheckpointBatchBytes: intEnv("MAX_CHECKPOINT_BATCH_BYTES", 6_000_000),
  maxCheckpointFileBytes: intEnv("MAX_CHECKPOINT_FILE_BYTES", 1_000_000),
};

export type BudgetExhaustion = "exec_calls" | "runtime_seconds" | "iterations";

/**
 * Per-run spend meter. Every allowance is checked *before* the call, so a run
 * degrades with a stated reason instead of silently billing more compute.
 *
 * Counters are authoritative in memory for the lifetime of one run and mirrored
 * to Postgres at the end, because a run is driven by a single loop.
 */
export interface BudgetSummary {
  activations: number;
  execCalls: number;
  runtimeMs: number;
  iterations: number;
  iterationsRemaining: number;
  exhausted: BudgetExhaustion | null;
  limits: BudgetLimits;
}

export type GateResult = { ok: true } | { ok: false; message: string };

export class RuntimeBudget {
  readonly limits: BudgetLimits;
  activations = 0;
  execCalls = 0;
  runtimeMs = 0;
  iterations = 0;

  constructor(limits: BudgetLimits = DEFAULT_BUDGET_LIMITS) {
    this.limits = limits;
  }

  get exhausted(): BudgetExhaustion | null {
    if (this.execCalls >= this.limits.maxExecCallsPerRun) return "exec_calls";
    if (this.runtimeMs >= this.limits.maxRuntimeSecondsPerRun * 1000) return "runtime_seconds";
    if (this.iterations >= this.limits.maxAgentIterations) return "iterations";
    return null;
  }

  get iterationsRemaining(): number {
    return Math.max(0, this.limits.maxAgentIterations - this.iterations);
  }

  /**
   * Gate for starting compute. `maxActivationsPerRun` defaults to 1, so a run
   * that already attached to a live Sandbox cannot pay for a second one.
   */
  startActivation(): GateResult {
    if (this.activations >= this.limits.maxActivationsPerRun) {
      return {
        ok: false,
        message:
          `Runtime activation limit for this run (${this.limits.maxActivationsPerRun}) is already used; ` +
          "no further compute will be started.",
      };
    }
    this.activations += 1;
    return { ok: true };
  }

  /**
   * Gate for one command. Exec calls are the dominant cost driver on this
   * provider because every filesystem operation is also a command, so reads and
   * writes are charged here too, not just `run_command`.
   */
  startExec(): GateResult {
    const exhausted = this.exhausted;
    if (exhausted === "exec_calls") {
      return {
        ok: false,
        message: `Exec-call budget exhausted (${this.limits.maxExecCallsPerRun} per run) — stopping instead of spending more runtime.`,
      };
    }
    if (exhausted === "runtime_seconds") {
      return {
        ok: false,
        message: `Runtime wall-clock budget exhausted (${this.limits.maxRuntimeSecondsPerRun}s for this run) — stopping instead of spending more runtime.`,
      };
    }
    if (exhausted === "iterations") {
      return {
        ok: false,
        message: `Iteration budget exhausted (${this.limits.maxAgentIterations} per run).`,
      };
    }
    this.execCalls += 1;
    return { ok: true };
  }

  /** Cap a command's own deadline at the configured ceiling. */
  commandTimeoutMs(requestedMs?: number): number {
    const ceiling = this.limits.maxCommandTimeoutMs;
    if (!requestedMs || !Number.isFinite(requestedMs)) return ceiling;
    return Math.min(Math.max(1_000, Math.floor(requestedMs)), ceiling);
  }

  /** Charge one iteration. Returns false once the ceiling is reached. */
  useIteration(): boolean {
    if (this.iterations >= this.limits.maxAgentIterations) return false;
    this.iterations += 1;
    return true;
  }

  /** Wall-clock this run held compute, for the runtime_seconds ceiling. */
  recordRuntimeMs(ms: number): void {
    this.runtimeMs += Math.max(0, Math.floor(ms));
  }

  /** The auditable spend record stored in agent_runs.budget_json. */
  summary(): BudgetSummary {
    return {
      activations: this.activations,
      execCalls: this.execCalls,
      runtimeMs: this.runtimeMs,
      iterations: this.iterations,
      iterationsRemaining: this.iterationsRemaining,
      exhausted: this.exhausted,
      limits: this.limits,
    };
  }
}

/** Shape stored in `agent_runs.budget_json`. */
export function budgetSnapshotForStorage(budget: RuntimeBudget): BudgetSummary {
  return budget.summary();
}
