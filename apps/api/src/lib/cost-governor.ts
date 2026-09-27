/**
 * The monthly compute budget.
 *
 * On the free tier this is not a billing concern but a survival one: exceeding
 * an allotment does not produce an invoice, it pauses sandbox creation for 30
 * days, taking the product away completely. So the ceiling is enforced here,
 * before a machine is ever asked for, at a fraction below the real limit.
 *
 * Two quantities matter and they are not the same quantity:
 *
 *   - Active CPU, which only command execution spends and which excludes I/O
 *     wait — so a run that spends two minutes waiting on the model is free.
 *   - Provisioned memory, which is wall clock of a running VM multiplied by its
 *     GB, including every idle second. A sandbox left awake to serve previews
 *     drains this without doing anything at all.
 *
 * The second is usually the tighter of the two, which is why `throttle` turns
 * previews off and why nothing in this stack may boot a machine merely to look
 * at its files.
 */

import {
  closeUsageSession,
  lastEscalationAt,
  listOpenUsageSessions,
  monthKey,
  readMonthUsage,
  recordEscalation,
  type MonthTotals,
} from "@dai/db";
import { RuntimeOperationError } from "@dai/runtime";
import { configFromEnv, isRuntimeConfigured, type MonthlyBudget, type VercelRuntimeConfig } from "@dai/vercel";

export type ThrottleLevel = "ok" | "warn" | "throttle" | "halt";

export interface SpendFraction {
  used: number;
  limit: number;
  fraction: number;
}

export interface BudgetHeadroom {
  month: string;
  level: ThrottleLevel;
  /** The metric furthest through its allowance; what a refusal is blamed on. */
  binding: keyof MonthTotals;
  fractions: Record<keyof MonthTotals, SpendFraction>;
  totals: MonthTotals;
}

const GB_MS_PER_GB_HOUR = 3_600_000;

function fraction(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return used / limit;
}

/** Provisioned GB-milliseconds → GB-hours, the unit the ceiling is stated in. */
export function toGbHours(provisionedGbMs: number): number {
  return provisionedGbMs / GB_MS_PER_GB_HOUR;
}

function levelFor(worst: number, budget: MonthlyBudget): ThrottleLevel {
  if (worst >= budget.haltFraction) return "halt";
  if (worst >= budget.throttleFraction) return "throttle";
  if (worst >= budget.warnFraction) return "warn";
  return "ok";
}

/**
 * Where the month stands, read from the aggregate rather than the ledger rows.
 *
 * Egress is deliberately excluded from the level: the app cannot make a
 * transfer cheaper by refusing to boot, so treating it as a stop condition
 * would disable the product for a quantity it cannot control here. It is still
 * reported.
 */
export async function readHeadroom(budget: MonthlyBudget, now: Date = new Date()): Promise<BudgetHeadroom> {
  const month = monthKey(now);
  const totals = await readMonthUsage(month);

  const limits: Record<keyof MonthTotals, number> = {
    activeCpuMs: budget.activeCpuMs,
    provisionedGbMs: budget.provisionedGbHours * GB_MS_PER_GB_HOUR,
    creations: budget.creations,
    egressBytes: budget.egressBytes,
  };

  const fractions = {
    activeCpuMs: { used: totals.activeCpuMs, limit: limits.activeCpuMs, fraction: fraction(totals.activeCpuMs, limits.activeCpuMs) },
    provisionedGbMs: { used: totals.provisionedGbMs, limit: limits.provisionedGbMs, fraction: fraction(totals.provisionedGbMs, limits.provisionedGbMs) },
    creations: { used: totals.creations, limit: limits.creations, fraction: fraction(totals.creations, limits.creations) },
    egressBytes: { used: totals.egressBytes, limit: limits.egressBytes, fraction: fraction(totals.egressBytes, limits.egressBytes) },
  };

  const controllable: Array<keyof MonthTotals> = ["activeCpuMs", "provisionedGbMs", "creations"];
  let binding: keyof MonthTotals = "activeCpuMs";
  for (const key of controllable) {
    if (fractions[key].fraction > fractions[binding].fraction) binding = key;
  }
  const worst = Math.max(...controllable.map((key) => fractions[key].fraction));

  return { month, level: levelFor(worst, budget), binding, fractions, totals };
}

/** Reset date, phrased the way a refusal should phrase it. */
function nextCycle(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Refuse before booting, not after.
 *
 * A refusal after `Sandbox.create` is not a refusal — the machine exists and the
 * clock is already running. Callers reach this before any acquire.
 */
export async function assertWithinComputeBudget(now: Date = new Date(), config?: VercelRuntimeConfig): Promise<BudgetHeadroom> {
  const resolved = config ?? configFromEnv();
  const headroom = await readHeadroom(resolved.budget, now);
  if (headroom.level === "halt") {
    const label =
      headroom.binding === "activeCpuMs"
        ? "command CPU"
        : headroom.binding === "provisionedGbMs"
          ? "running time"
          : "sandbox creations";
    throw new RuntimeOperationError(
      `This month's compute allowance is spent (${label}). New runs are paused to avoid the ` +
        `provider suspending sandboxes entirely; it resumes on ${nextCycle(now)}. Browsing files, ` +
        `diffs and undo still work — they cost no compute.`,
      "quota"
    );
  }
  return headroom;
}

/** True when expensive conveniences (bigger boxes, previews) must be declined. */
export function allowsEscalation(level: ThrottleLevel): boolean {
  return level === "ok" || level === "warn";
}

export function allowsPreview(level: ThrottleLevel): boolean {
  return level !== "throttle" && level !== "halt";
}

/**
 * Why a dev server must not start right now, or null when it may.
 *
 * A preview is the cheapest thing to build and the most expensive thing to run:
 * it holds a whole awake VM for as long as the tab stays open, and provisioned
 * memory — not CPU — is the ceiling that goes first here. The refusal is worded
 * for the model too, because the tool result goes straight back into its context
 * and it needs to know to finish with file tools instead of retrying.
 */
export async function previewRefusalReason(
  now: Date = new Date(),
  config?: VercelRuntimeConfig
): Promise<string | null> {
  const resolved = config ?? configFromEnv();
  const headroom = await readHeadroom(resolved.budget, now);
  if (allowsPreview(headroom.level)) return null;
  return (
    `Previews are paused for this month: ${headroom.binding === "provisionedGbMs" ? "running time" : "the compute allowance"} ` +
    `is at ${Math.round(headroom.fractions[headroom.binding].fraction * 100)}% of its limit, and a dev server holds ` +
    `an awake machine for as long as it runs. Finish with the file tools instead — reading and writing ` +
    `files are transfers, not commands — and verify by inspection. This lifts on ${nextCycle(now)}.`
  );
}

/** The throwing form, for HTTP routes that should answer 429 rather than prose. */
export async function assertPreviewAllowed(now: Date = new Date(), config?: VercelRuntimeConfig): Promise<void> {
  const reason = await previewRefusalReason(now, config);
  if (reason) throw new RuntimeOperationError(reason, "quota");
}

/** Wall clock a session ran, for the provisioned-memory charge. */
export function provisionedMsFor(startedAtIso: string, now: Date = new Date()): number {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, now.getTime() - started);
}

/**
 * A bounded, metered step up, never a loop.
 *
 * Escalation costs a creation and more memory, so it is allowed once per project
 * per week, only while the budget has room, and only while the machine is not
 * already the largest offered. A timeout at the top tier must end the run rather
 * than keep buying bigger machines that also time out.
 */
export async function nextTierAfterTimeout(
  projectId: string,
  currentTier: number,
  config: VercelRuntimeConfig,
  level: ThrottleLevel,
  now: Date = new Date()
): Promise<number> {
  const top = Math.max(0, config.tiers.length - 1);
  if (!allowsEscalation(level)) return currentTier;
  if (currentTier >= top) return currentTier;

  const last = await lastEscalationAt(projectId);
  if (last) {
    const daysSince = (now.getTime() - Date.parse(last)) / 86_400_000;
    if (Number.isFinite(daysSince) && daysSince < 7) return currentTier;
  }

  await recordEscalation(projectId);
  return currentTier + 1;
}

/**
 * Close ledger rows nobody closed.
 *
 * A process killed mid-run leaves an open row, and an open row means the month's
 * total is understated — which is precisely the error that lets a budget be
 * blown. The estimate is pessimistic in the right direction: wall clock only, and
 * CPU attributed at zero, because provisioned memory is the ceiling most likely to
 * be the binding one.
 */
export async function reconcileOpenSessions(olderThanMinutes = 90): Promise<number> {
  const open = await listOpenUsageSessions(olderThanMinutes);
  for (const session of open) {
    await closeUsageSession(
      session.id,
      { activeCpuMs: 0, provisionedMs: provisionedMsFor(session.startedAt), egressBytes: 0 },
      { vcpus: session.vcpus, reconciled: true }
    );
  }
  return open.length;
}

/** Human-readable spend, shared by the status endpoint and the model's own report. */
export function describeHeadroom(headroom: BudgetHeadroom, budget: MonthlyBudget): string {
  const cpuHours = headroom.totals.activeCpuMs / 3_600_000;
  const gbHours = toGbHours(headroom.totals.provisionedGbMs);
  return `${cpuHours.toFixed(2)}/${(budget.activeCpuMs / 3_600_000).toFixed(0)} command-CPU hours, ` +
    `${gbHours.toFixed(1)}/${budget.provisionedGbHours} running GB-hours, ` +
    `${headroom.totals.creations}/${budget.creations} sandbox boots (month ${headroom.month}, level ${headroom.level})`;
}

/** Convenience for callers that only need to know whether the provider is in use. */
export function computeBudgetEnforced(): boolean {
  return isRuntimeConfigured();
}
