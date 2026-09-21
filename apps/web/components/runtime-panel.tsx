"use client";

/**
 * The strip's Runtime and Status tabs.
 *
 * Both are read-only views over facts the API already returned. The runtime is
 * described in provider-neutral words ("compute attached", "idle") because the
 * browser must not name or talk to the execution provider directly.
 */

import type { AgentRun, Project, RunStatus } from "@dai/types";
import { Cpu, RotateCcw } from "lucide-react";
import type { WorkspaceStatus } from "@/lib/api-contract";
import { stateMeta, toneVar } from "@/lib/agent-view";
import { dateTime, modelLabel } from "@/lib/format";
import { BudgetMeter } from "./budget-meter";
import { EmptyState, MetaRow, PanelHeader, TextButton, ToneDot } from "./panel";

const BOOTUP_COPY: Record<string, string> = {
  CLEAN: "New workspace",
  RESUME: "Reattached",
  RUNNING: "Already running",
  FORK: "Forked",
};

const RUNTIME_COPY: Record<string, string> = {
  running: "Compute attached",
  provisioning: "Provisioning",
  hibernated: "Idle — files stored",
  stopped: "Idle — files stored",
  archived: "Archived",
  unknown: "Unknown",
  error: "Error",
};

function shortId(id: string | null): string {
  if (!id) return "—";
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-3)}` : id;
}

export interface RuntimePanelProps {
  status: WorkspaceStatus | null;
  run: AgentRun | null;
  limits: RunStatus["limits"] | null;
  budgetLoading: boolean;
  runtimeBusy: boolean;
  model: string;
  onRestart: () => void;
}

export function RuntimePanel({ status, run, limits, budgetLoading, runtimeBusy, model, onRestart }: RuntimePanelProps) {
  const state = status?.state ?? "unknown";
  const tone = state === "running" ? "success" : state === "error" || state === "unknown" ? "danger" : "warning";
  return (
    <section className="flex flex-col min-h-0 h-full" aria-label="Runtime">
      <PanelHeader
        title="Runtime"
        meta={
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: toneVar(tone) }}>
            <ToneDot tone={tone} live={state === "running"} />
            {RUNTIME_COPY[state] ?? state}
          </span>
        }
        actions={
          <TextButton variant="ghost" onClick={onRestart} busy={runtimeBusy} className="text-[12px]" title="Reattach compute to this workspace. Stored files are not affected.">
            <RotateCcw size={13} aria-hidden="true" />
            Reattach
          </TextButton>
        }
      />
      <div className="grid gap-4 p-3 overflow-y-auto min-h-0">
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
          <dl>
            <MetaRow label="Workspace" value={BOOTUP_COPY[status?.bootupType ?? ""] ?? "—"} />
            <MetaRow label="Runtime id" value={<span className="font-mono">{shortId(status?.sandboxId ?? null)}</span>} />
            <MetaRow label="Provider" value={status?.runtimeProvider ?? "—"} />
          </dl>
          <dl>
            <MetaRow
              label="Dev server"
              value={status?.devServerRunning ? `Running on port ${status.devServerPort ?? "—"}` : "Not running"}
            />
            <MetaRow label="Model" value={model ? modelLabel(model) : "—"} />
            <MetaRow
              label="Compute"
              value={status?.isHibernated ? "Released when idle" : "Attached now"}
            />
          </dl>
        </div>

        <div className="border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
          <BudgetMeter run={run} limits={limits} loading={budgetLoading} exhausted={run?.outcome === "budget_exhausted"} />
        </div>

        <p className="text-[11px] leading-4 flex items-start gap-1.5" style={{ color: "var(--text-muted)" }}>
          <Cpu size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          Budgets are per run and set by the backend. A run that reaches one stops on cost, which is reported
          separately from a failure.
        </p>
      </div>
    </section>
  );
}

export interface StatusPanelProps {
  project: Project | null;
  status: WorkspaceStatus | null;
  run: AgentRun | null;
  checkpointCount: number;
  eventCount: number;
  elapsed: string;
  error?: string | null;
}

export function StatusPanel({ project, status, run, checkpointCount, eventCount, elapsed, error }: StatusPanelProps) {
  const state = stateMeta(run?.state ?? null);
  if (!project && !status) {
    return (
      <section className="flex flex-col min-h-0 h-full" aria-label="Status">
        <PanelHeader title="Status" />
        <EmptyState title="Nothing to report yet" hint="Status appears once the workspace has loaded." />
      </section>
    );
  }
  return (
    <section className="flex flex-col min-h-0 h-full" aria-label="Status">
      <PanelHeader
        title="Status"
        meta={
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: toneVar(state.tone) }}>
            <ToneDot tone={state.tone} live={state.live} />
            {run ? state.label : "No run yet"}
          </span>
        }
      />
      <div className="grid sm:grid-cols-2 gap-x-6 p-3 overflow-y-auto min-h-0">
        <dl>
          <MetaRow label="Project" value={project?.name ?? "—"} />
          <MetaRow label="Slug" value={<span className="font-mono">{project?.slug ?? "—"}</span>} />
          <MetaRow label="Project status" value={project?.status ?? "—"} />
          <MetaRow label="Last accessed" value={project?.lastAccessedAt ? dateTime(project.lastAccessedAt) : "—"} />
          <MetaRow label="Created" value={project?.createdAt ? dateTime(project.createdAt) : "—"} />
        </dl>
        <dl>
          <MetaRow label="Run elapsed" value={elapsed || "—"} />
          <MetaRow label="Activity events" value={String(eventCount)} />
          <MetaRow label="Checkpoints" value={String(checkpointCount)} />
          <MetaRow
            label="Files changed"
            value={run?.counts ? String(run.counts.filesChanged) : "—"}
          />
          <MetaRow label="Stop reason" value={run?.stopReason ?? "—"} />
        </dl>
      </div>
      {error || status?.lastError ? (
        <div className="px-3 pb-3 space-y-1.5">
          {status?.lastError ? (
            <p className="text-[11px] leading-4 rounded-md p-2" style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", color: "var(--danger)" }}>
              {status.lastError}
            </p>
          ) : null}
          {error ? (
            <p className="text-[11px] leading-4 rounded-md p-2" style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", color: "var(--warning)" }}>
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
