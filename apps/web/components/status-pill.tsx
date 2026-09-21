"use client";

/**
 * The workspace's single status pill.
 *
 * There is deliberately one pill and one derivation rule: the agent run's own
 * state wins over everything else, because "what is the agent doing" is the
 * question the pill answers. Runtime state has its own home in the Status panel
 * so the two can never disagree on screen.
 */

import type { AgentRun } from "@dai/types";
import { outcomeCopy, stateMeta, toneVar, type Tone } from "@/lib/agent-view";
import { ToneDot } from "./panel";

export interface PillView {
  label: string;
  tone: Tone;
  live: boolean;
}

export function pillForRun(run: AgentRun | null, live: boolean, streaming: boolean): PillView {
  if (streaming) {
    const state = stateMeta(run?.state ?? "queued");
    return { label: state.label, tone: "running", live: true };
  }
  if (!run) return { label: "Idle", tone: "neutral", live: false };
  const outcome = outcomeCopy(run);
  if (live) {
    const state = stateMeta(run.state);
    return { label: state.label, tone: state.tone === "neutral" ? "running" : state.tone, live: true };
  }
  if (outcome) return { label: outcome.label, tone: outcome.tone, live: false };
  const state = stateMeta(run.state);
  return { label: state.label, tone: state.tone, live: false };
}

export function StatusPill({ view, title }: { view: PillView; title?: string }) {
  return (
    <span
      className="badge shrink-0"
      style={{
        color: toneVar(view.tone),
        background: `color-mix(in srgb, ${toneVar(view.tone)} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${toneVar(view.tone)} 22%, transparent)`,
        height: 24,
        padding: "0 8px",
      }}
      title={title ?? view.label}
      aria-live="polite"
    >
      <ToneDot tone={view.tone} live={view.live} size={6} />
      {view.label}
    </span>
  );
}
