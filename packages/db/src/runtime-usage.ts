/**
 * Persistence for the compute ledger.
 *
 * Two tables, one granular and one aggregated, because the two readers differ:
 * a person asking "what happened last week" needs rows, and every sandbox boot
 * needs one number fast. Aggregating on write keeps the boot-time check to a
 * single indexed row read instead of a scan that grows through the month.
 */

import { query } from "./client.js";

export interface UsageSession {
  id: number;
  projectId: string;
  userId: string;
  runId: string | null;
  sandboxName: string;
  kind: "agent" | "preview" | "maintenance";
  vcpus: number;
}

export interface SessionUsage {
  activeCpuMs: number;
  provisionedMs: number;
  egressBytes: number;
}

export interface MonthTotals {
  activeCpuMs: number;
  /** GB × milliseconds, so the GB-hour ceiling is a single division away. */
  provisionedGbMs: number;
  creations: number;
  egressBytes: number;
}

export const EMPTY_MONTH: MonthTotals = {
  activeCpuMs: 0,
  provisionedGbMs: 0,
  creations: 0,
  egressBytes: 0,
};

/** UTC calendar month, matching how the provider resets its own period. */
export function monthKey(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Record that a session began, and charge the creation.
 *
 * `chargedCreation` is false when the sandbox already existed, because resuming
 * does not consume the creation allowance — the distinction is the whole reason
 * the acquire path has to report it.
 */
export async function startUsageSession(
  session: Omit<UsageSession, "id">,
  opts: { chargedCreation: boolean; month?: string }
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO runtime_usage
       (project_id, user_id, run_id, sandbox_name, kind, vcpus)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [session.projectId, session.userId, session.runId, session.sandboxName, session.kind, session.vcpus]
  );
  const id = Number(res.rows[0]?.id ?? 0);
  if (opts.chargedCreation) {
    await addMonthUsage(opts.month ?? monthKey(), { ...EMPTY_MONTH, creations: 1 });
  }
  return id;
}

/**
 * Close a session and fold its usage into the month.
 *
 * The increment is one statement rather than a read-modify-write: two sessions
 * finishing at the same moment must both be counted, and the ceiling is only
 * trustworthy if nothing can be lost between reading and writing it.
 */
export async function closeUsageSession(
  usageId: number,
  usage: SessionUsage,
  opts: { month?: string; vcpus: number; reconciled?: boolean }
): Promise<void> {
  await query(
    `UPDATE runtime_usage
        SET stopped_at = now(),
            active_cpu_ms = $2,
            provisioned_ms = $3,
            egress_bytes = $4,
            reconciled = $5
      WHERE id = $1 AND stopped_at IS NULL`,
    [usageId, usage.activeCpuMs, usage.provisionedMs, usage.egressBytes, opts.reconciled ?? false]
  );
  await addMonthUsage(opts.month ?? monthKey(), {
    activeCpuMs: usage.activeCpuMs,
    // Provisioned memory is 2 GB per vCPU on this platform, so GB-hours is
    // wall clock multiplied by twice the vCPU count.
    provisionedGbMs: usage.provisionedMs * opts.vcpus * 2,
    creations: 0,
    egressBytes: usage.egressBytes,
  });
}

async function addMonthUsage(month: string, usage: MonthTotals): Promise<void> {
  await query(
    `INSERT INTO runtime_quota_state
       (month, active_cpu_ms, provisioned_gb_ms, creations, egress_bytes, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (month) DO UPDATE
       SET active_cpu_ms = runtime_quota_state.active_cpu_ms + EXCLUDED.active_cpu_ms,
           provisioned_gb_ms = runtime_quota_state.provisioned_gb_ms + EXCLUDED.provisioned_gb_ms,
           creations = runtime_quota_state.creations + EXCLUDED.creations,
           egress_bytes = runtime_quota_state.egress_bytes + EXCLUDED.egress_bytes,
           updated_at = now()`,
    [month, usage.activeCpuMs, usage.provisionedGbMs, usage.creations, usage.egressBytes]
  );
}

export async function readMonthUsage(month: string): Promise<MonthTotals> {
  const res = await query<{
    active_cpu_ms: string | number;
    provisioned_gb_ms: string | number;
    creations: string | number;
    egress_bytes: string | number;
  }>(
    `SELECT active_cpu_ms, provisioned_gb_ms, creations, egress_bytes
       FROM runtime_quota_state WHERE month = $1`,
    [month]
  );
  const row = res.rows[0];
  if (!row) return { ...EMPTY_MONTH };
  return {
    activeCpuMs: Number(row.active_cpu_ms) || 0,
    provisionedGbMs: Number(row.provisioned_gb_ms) || 0,
    creations: Number(row.creations) || 0,
    egressBytes: Number(row.egress_bytes) || 0,
  };
}

/** Sessions still open, for reconciliation after a process died mid-run. */
export async function listOpenUsageSessions(olderThanMinutes: number): Promise<Array<UsageSession & { startedAt: string }>> {
  const res = await query<{
    id: number;
    project_id: string;
    user_id: string;
    run_id: string | null;
    sandbox_name: string;
    kind: string;
    vcpus: number;
    created_at: string;
  }>(
    `SELECT id, project_id, user_id, run_id, sandbox_name, kind, vcpus, created_at
       FROM runtime_usage
      WHERE stopped_at IS NULL AND created_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)]
  );
  return res.rows.map((row) => ({
    id: Number(row.id),
    projectId: row.project_id,
    userId: row.user_id,
    runId: row.run_id ?? null,
    sandboxName: row.sandbox_name,
    kind: row.kind as UsageSession["kind"],
    vcpus: row.vcpus,
    startedAt: row.created_at,
  }));
}

/** Most recent escalation timestamp, for the weekly cap on growing machines. */
export async function lastEscalationAt(projectId: string): Promise<string | null> {
  const res = await query<{ last_escalated_at: string | null }>(
    `SELECT last_escalated_at FROM projects WHERE id = $1`,
    [projectId]
  );
  return res.rows[0]?.last_escalated_at ?? null;
}

export async function recordEscalation(projectId: string): Promise<number> {
  const res = await query<{ runtime_escalations: number }>(
    `UPDATE projects
        SET runtime_escalations = runtime_escalations + 1,
            last_escalated_at = now()
      WHERE id = $1
      RETURNING runtime_escalations`,
    [projectId]
  );
  return Number(res.rows[0]?.runtime_escalations ?? 0);
}

/**
 * How long a ledger row has been open, measured by the database clock.
 *
 * Wall clock is what provisioned memory is billed in, and the API host's clock is
 * both less authoritative and prone to skew between the process that opened the
 * row and the one that closes it.
 */
export async function usageRowAgeMs(usageId: number): Promise<number> {
  const res = await query<{ age_ms: string | number }>(
    `SELECT EXTRACT(EPOCH FROM (now() - created_at)) * 1000 AS age_ms
       FROM runtime_usage WHERE id = $1`,
    [usageId]
  );
  return Math.max(0, Math.round(Number(res.rows[0]?.age_ms ?? 0)));
}
