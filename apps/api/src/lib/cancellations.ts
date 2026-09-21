/**
 * Cooperative cancellation for in-flight agent runs.
 *
 * A run is driven by one loop in this process, so a flag is enough — but the
 * flag is only ever observed *between* iterations, never in the middle of a
 * command. That matters because the Sandbox is not ours to interrupt cheaply and
 * a half-applied batch of edits would be worse than a slightly late stop.
 */

const cancelled = new Set<string>();

export function registerCancellation(runId: string): void {
  cancelled.add(runId);
}

export function isCancelled(runId: string): boolean {
  return cancelled.has(runId);
}

export function unregisterCancellation(runId: string): void {
  cancelled.delete(runId);
}

/** Guard against unbounded growth if a run never reaches its finally block. */
export function cancellationCount(): number {
  return cancelled.size;
}
