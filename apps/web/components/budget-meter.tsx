"use client";

/**
 * Budget honesty.
 *
 * Shows what a run consumed against the limits the server reported, so a run
 * that stopped on cost is visibly different from one that failed. The `used`
 * numbers are the run's own counts; nothing is extrapolated.
 */

import type { AgentRun, RunStatus } from "@dai/types";
import { budgetRows, budgetTone, toneVar } from "@/lib/agent-view";
import { Skeleton } from "./loading-skeleton";

export interface BudgetMeterProps {
  run: AgentRun | null;
  limits: RunStatus["limits"] | null;
  loading: boolean;
  exhausted?: boolean;
}

export function BudgetMeter({ run, limits, loading, exhausted }: BudgetMeterProps) {
  const rows = budgetRows(run, limits);

  return (
    <div className="pl-4 pt-1">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h3 className="text-[10px] uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
          Budget used
        </h3>
        {exhausted ? (
          <span className="text-[11px]" style={{ color: "var(--danger)", fontWeight: 510 }}>
            Limit reached
          </span>
        ) : null}
      </div>

      {loading && rows.length === 0 ? (
        <div className="space-y-2">
          <Skeleton style={{ height: 8 }} />
          <Skeleton style={{ height: 8, width: "70%" }} />
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          {rows.map((row) => {
            const ratio = row.limit > 0 ? Math.min(1, row.used / row.limit) : 0;
            const tone = budgetTone(row.used, row.limit);
            return (
              <div key={row.key}>
                <div className="flex items-baseline justify-between gap-1">
                  <dt className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                    {row.label}
                  </dt>
                  <dd
                    className="font-mono text-[11px] shrink-0"
                    style={{ color: tone === "neutral" ? "var(--text-secondary)" : toneVar(tone) }}
                  >
                    {row.used}
                    {row.unit}
                    <span style={{ color: "var(--text-muted)" }}>
                      /{row.limit}
                      {row.unit}
                    </span>
                  </dd>
                </div>
                <div
                  className="mt-1 rounded-full overflow-hidden"
                  style={{ height: 3, background: "color-mix(in srgb, var(--text-primary) 8%, transparent)" }}
                  role="meter"
                  aria-valuenow={row.used}
                  aria-valuemin={0}
                  aria-valuemax={row.limit}
                  aria-label={`${row.label} used`}
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${ratio * 100}%`, background: toneVar(tone === "neutral" ? "accent" : tone) }}
                  />
                </div>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}
