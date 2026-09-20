import {
  claimNextSandboxJob,
  completeSandboxJob,
  countActiveSandboxes,
  enqueueSandboxJob,
  failSandboxJob,
  type SandboxQueueJob,
} from "@dai/db";

export const MAX_ACTIVE_SANDBOXES = 10;

type SandboxJobAction = "create" | "resume";

type SandboxJobHandler = (job: SandboxQueueJob) => Promise<void>;

const handlers = new Map<SandboxJobAction, SandboxJobHandler>();

export interface SandboxSlotResult {
  acquired: boolean;
  job?: SandboxQueueJob;
  activeCount: number;
}

export function registerSandboxJobHandler(action: SandboxJobAction, handler: SandboxJobHandler): void {
  handlers.set(action, handler);
}

export async function requestSandboxSlot(
  userId: string,
  projectId: string,
  action: SandboxJobAction,
  payload: Record<string, unknown> = {}
): Promise<SandboxSlotResult> {
  const activeCount = await countActiveSandboxes(userId);
  if (activeCount < MAX_ACTIVE_SANDBOXES) {
    return { acquired: true, activeCount };
  }

  const job = await enqueueSandboxJob(userId, projectId, action, payload);
  return { acquired: false, job, activeCount };
}

export async function processNextSandboxJob(): Promise<boolean> {
  const job = await claimNextSandboxJob();
  if (!job) return false;

  const handler = handlers.get(job.action);
  if (!handler) {
    await failSandboxJob(job.id, `No handler registered for ${job.action}`);
    return true;
  }

  // Concurrency guard: if this user is already at the active-sandbox cap,
  // put the job back at the head of the queue instead of overshooting.
  const activeCount = await countActiveSandboxes(job.userId);
  if (activeCount >= MAX_ACTIVE_SANDBOXES) {
    await requeueSandboxJob(job.id);
    return false;
  }

  try {
    await handler(job);
    await completeSandboxJob(job.id);
  } catch (error: any) {
    await failSandboxJob(job.id, error?.message || "Sandbox job failed");
  }

  return true;
}

/**
 * Start a polling worker that drains the sandbox queue. State lives entirely
 * in PostgreSQL (sandbox_queue + projects), so this is safe across Render
 * restarts and multiple instances: claimNextSandboxJob() uses
 * FOR UPDATE SKIP LOCKED, so two workers never grab the same job.
 */
export async function startSandboxQueueWorker(intervalMs = 15_000): Promise<NodeJS.Timeout> {
  const { requeueStaleSandboxJobs } = await import("@dai/db");
  const tick = async () => {
    try {
      // Recover jobs whose worker died mid-flight (Render restarts).
      const requeued = await requeueStaleSandboxJobs(5);
      if (requeued > 0) console.log(`[sandbox-queue] requeued ${requeued} stale job(s)`);
      await processSandboxQueue();
    } catch (error: any) {
      console.warn(`[sandbox-queue] worker tick failed: ${error?.message ?? error}`);
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}

/** Put a claimed job back in the queue (used when the user is at the concurrency cap). */
async function requeueSandboxJob(jobId: string): Promise<void> {
  const { pool } = await import("@dai/db");
  await pool.query(
    `UPDATE sandbox_queue SET status = 'queued', claimed_at = NULL, updated_at = now() WHERE id = $1`,
    [jobId]
  );
}

export async function processSandboxQueue(): Promise<void> {
  while (await processNextSandboxJob()) {
    // Drain the queue until no job is ready.
  }
}

export async function getSandboxQueueStatus(userId: string) {
  const { pool } = await import("@dai/db");
  const res = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::int AS count
     FROM sandbox_queue
     WHERE user_id = $1 AND status IN ('queued', 'processing')
     GROUP BY status`,
    [userId]
  );
  const byStatus = Object.fromEntries(res.rows.map((row: any) => [row.status, Number(row.count)]));
  return {
    activeCount: await countActiveSandboxes(userId),
    maxAllowed: MAX_ACTIVE_SANDBOXES,
    queued: byStatus.queued ?? 0,
    processing: byStatus.processing ?? 0,
  };
}
