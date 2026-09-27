/**
 * Runtime policy: what each operation actually costs, and how much a single
 * agent run is allowed to spend.
 *
 * The classification is a provider fact and was re-derived when the runtime
 * moved, because the previous provider and this one disagree about almost
 * everything:
 *
 *   - Modal's JavaScript `Volume` exposed no file API at all, and
 *     `SandboxFilesystem` was sugar over `exec`, so *every* workspace byte was a
 *     command and therefore compute.
 *   - Vercel Sandbox has a real control-plane byte API (`readFileToBuffer`,
 *     `writeFiles`): HTTP transfers that accrue no Active CPU — but each one
 *     needs a RUNNING sandbox, and a running sandbox bills provisioned memory on
 *     wall clock whether or not it is thinking. Its `fs.readdir`/`stat`/`rm`/
 *     `rename`/`mkdir` are *not* that: the SDK implements them as commands.
 *   - Anything mirrored to R2 (every file this app wrote) needs no sandbox at
 *     all, and is the only genuinely free path.
 *
 * So cost is not one boolean. Each operation has a location — where the bytes
 * come from — and two consequences: whether a running sandbox is needed, and
 * whether Active CPU is spent. Only `runCommand` accrues Active CPU, which is
 * why reads and writes are unmetered while listing, deleting, renaming and
 * searching are charged exactly like a command.
 */

export type RuntimeOperation =
  | "fs.list"
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "fs.rename"
  | "fs.search_name"
  | "fs.search_content"
  | "command.exec"
  | "dev_server.start"
  | "preview.url"
  | "git.status"
  | "git.diff"
  | "checkpoint.restore";

/** Where the bytes for this operation come from, or go to. */
export type RuntimeLocation = "r2" | "control_plane" | "sandbox_exec";

export type CostClass = "free" | "runtime";

export interface RuntimeDecision {
  operation: RuntimeOperation;
  location: RuntimeLocation;
  /** True when a sandbox has to be awake for this to work at all. */
  requiresRunningSandbox: boolean;
  /** True when the operation runs a command and so spends Active CPU. */
  activeCpuCost: boolean;
  /** Kept for the activity timeline: "free" means no command and no activation. */
  cost: CostClass;
  /** Human-readable, and surfaced verbatim in the activity timeline. */
  reason: string;
  /** Set when the operation is degraded rather than executed. */
  degraded?: boolean;
}

interface Classification {
  location: RuntimeLocation;
  requiresRunningSandbox: boolean;
  activeCpuCost: boolean;
  reason: string;
}

/**
 * One row per operation. `cost` is derived from the two axes rather than stated
 * again, so the table cannot contradict itself.
 *
 * The rows are pinned to the installed SDK, not to the API docs: in
 * `@vercel/sandbox`, `readFileToBuffer` and `writeFiles` are HTTP data-plane
 * calls, while `fs.readdir`, `fs.stat`, `fs.rm`, `fs.rename` and
 * `fs.mkdir(recursive)` are implemented as `find`/`stat`/`rm`/`mv`/`mkdir`
 * commands. "File API" therefore does not mean "free" — only the two byte
 * transfers are.
 */
const CLASSIFIED: Record<RuntimeOperation, Classification> = {
  "fs.read": {
    location: "r2",
    requiresRunningSandbox: false,
    activeCpuCost: false,
    reason: "Mirrored to object storage on write, so a cold project is readable with no sandbox running.",
  },
  "fs.list": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "The SDK implements a directory listing as a find command, so listing costs the same as running one.",
  },
  "fs.write": {
    location: "control_plane",
    requiresRunningSandbox: true,
    activeCpuCost: false,
    reason: "Writes are an HTTP transfer to the sandbox and a put to the mirror; neither runs a command.",
  },
  "fs.delete": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "The SDK deletes by running rm inside the sandbox, so a delete is a command.",
  },
  "fs.rename": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "The SDK renames by running mv inside the sandbox, so a rename is a command.",
  },
  "fs.search_name": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "Name search runs find, bounded to 200 paths and 12 levels; one command, not a walk of listings.",
  },
  "fs.search_content": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "Searching inside file contents runs grep across the tree, which is a command and is metered.",
  },
  "command.exec": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "Running a command is the only thing on this provider that spends Active CPU.",
  },
  "dev_server.start": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "A dev server is a command that keeps running, and the awake machine bills provisioned memory the whole time.",
  },
  "preview.url": {
    location: "control_plane",
    requiresRunningSandbox: true,
    activeCpuCost: false,
    reason: "The address is derived from the sandbox handle, and the browser reaches it through the proxy — no command.",
  },
  "git.status": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "git has to run against the working tree, so it is a command like any other.",
  },
  "git.diff": {
    location: "sandbox_exec",
    requiresRunningSandbox: true,
    activeCpuCost: true,
    reason: "git has to run against the working tree, so it is a command like any other.",
  },
  "checkpoint.restore": {
    location: "control_plane",
    requiresRunningSandbox: true,
    activeCpuCost: false,
    reason: "Undo writes the stored image back with the same byte transfer as any write; only a missing parent directory costs a command.",
  },
};

export function needsRuntime(operation: RuntimeOperation): RuntimeDecision {
  const classified = CLASSIFIED[operation];
  return {
    operation,
    location: classified.location,
    requiresRunningSandbox: classified.requiresRunningSandbox,
    activeCpuCost: classified.activeCpuCost,
    cost: classified.activeCpuCost || classified.location === "sandbox_exec" ? "runtime" : "free",
    reason: classified.reason,
  };
}

/** Operations that are free to attempt: the basis for the prompt's advice to the model. */
export function freeOperations(): RuntimeOperation[] {
  return (Object.keys(CLASSIFIED) as RuntimeOperation[]).filter(
    (operation) => !CLASSIFIED[operation].activeCpuCost
  );
}

/** Operations that spend Active CPU, and therefore need a reason before being run. */
export function meteredOperations(): RuntimeOperation[] {
  return (Object.keys(CLASSIFIED) as RuntimeOperation[]).filter(
    (operation) => CLASSIFIED[operation].activeCpuCost
  );
}

export interface BudgetLimits {
  maxActivationsPerRun: number;
  /** Metered commands only — the operations that spend Active CPU. */
  maxExecCallsPerRun: number;
  /**
   * Reads, listings and edits spend no command CPU but still occupy a running
   * machine, so they get their own ceiling. It is high because a real task does
   * hundreds of them; it exists so a stuck loop cannot hammer storage forever.
   */
  maxFileOpsPerRun: number;
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
  maxFileOpsPerRun: intEnv("MAX_FILE_OPS_PER_AGENT_RUN", 600),
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
  fileOps: number;
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
  fileOps = 0;
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
   * Gate for one metered command.
   *
   * Charged only where `needsRuntime().activeCpuCost` is true. Reads, listings
   * and edits used to be charged here as well, which was correct on the previous
   * provider — every filesystem call there was a command — and is wrong here:
   * metering them would stop a file-only task for spending nothing.
   */
  startExec(): GateResult {
    const exhausted = this.exhausted;
    if (exhausted === "exec_calls") {
      return {
        ok: false,
        message: `Command budget exhausted (${this.limits.maxExecCallsPerRun} per run) — stopping instead of spending more compute.`,
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

  /**
   * Gate for a filesystem operation, which is free of command CPU but still
   * holds the machine awake. Refusal wording matters: the model reads it, and it
   * must not conclude from "budget exhausted" that it should try a command
   * instead.
   */
  startFileOperation(): GateResult {
    if (this.fileOps >= this.limits.maxFileOpsPerRun) {
      return {
        ok: false,
        message:
          `This run has made ${this.limits.maxFileOpsPerRun} file operations, which is more than a task ` +
          "needs. Answer from what you have already read rather than searching again.",
      };
    }
    this.fileOps += 1;
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
      fileOps: this.fileOps,
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
