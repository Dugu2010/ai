"use client";

/**
 * The agent's activity timeline.
 *
 * Every row is an `ActivityEvent` the backend wrote: the sentence is its
 * `title`, the small print is derived from its `detail`. Nothing is generated
 * here, no raw tool payload is ever rendered, and an event with no facts shows
 * no facts.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActivityEvent, AgentRun } from "@dai/types";
import {
  Brain,
  CircleCheck,
  CircleX,
  Eye,
  FileText,
  FlaskConical,
  Gauge,
  Hammer,
  Pencil,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Terminal,
  Undo2,
  Wrench,
  FolderOpen,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import {
  eventFacts,
  eventMeta,
  eventPaths,
  outcomeCopy,
  stateMeta,
  toneVar,
  type ActivityIcon,
  type RunFacts,
} from "@/lib/agent-view";
import { clockTime } from "@/lib/format";
import { scrollToNode } from "@/lib/motion";
import { EmptyState, IconButton, NoticeBar, PanelHeader, ToneDot } from "./panel";

const ICONS: Record<ActivityIcon, LucideIcon> = {
  queue: CircleCheck,
  brain: Brain,
  folder: FolderOpen,
  search: Search,
  "file-text": FileText,
  pencil: Pencil,
  terminal: Terminal,
  "check-circle": CircleCheck,
  "x-circle": CircleX,
  flask: FlaskConical,
  hammer: Hammer,
  stethoscope: Stethoscope,
  wrench: Wrench,
  "shield-check": ShieldCheck,
  eye: Eye,
  play: Play,
  refresh: RefreshCw,
  undo: Undo2,
  alert: CircleX,
  gauge: Gauge,
  sparkles: Sparkles,
};

function EventIcon({ event }: { event: ActivityEvent }) {
  const meta = eventMeta(event.type);
  const Icon = ICONS[meta.icon] ?? Brain;
  return (
    <span
      aria-hidden="true"
      className="flex items-center justify-center rounded-md shrink-0"
      style={{
        width: 22,
        height: 22,
        color: toneVar(meta.tone),
        background: `color-mix(in srgb, ${toneVar(meta.tone)} 12%, transparent)`,
      }}
    >
      <Icon size={13} strokeWidth={1.75} />
    </span>
  );
}

function EventRow({ event, isCurrent }: { event: ActivityEvent; isCurrent: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = eventMeta(event.type);
  const facts = eventFacts(event);
  const paths = eventPaths(event);
  const showText = event.type === "agent.error" || event.type === "agent.loop.detected" || event.type === "agent.budget.exhausted";

  return (
    <li className="group" aria-current={isCurrent ? "step" : undefined}>
      <div className="flex items-start gap-2 px-3 py-1.5">
        <div className="flex flex-col items-center pt-0.5 shrink-0">
          <EventIcon event={event} />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="text-[13px] leading-5"
            style={{
              color: showText ? toneVar(meta.tone) : "var(--text-secondary)",
              fontWeight: isCurrent || showText ? 510 : 400,
            }}
          >
            {event.title}
          </p>
          {(facts || paths.length > 0) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {facts ? (
                <span className="font-mono text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
                  {facts}
                </span>
              ) : null}
              {paths.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setOpen((prev) => !prev)}
                  aria-expanded={open}
                  className="inline-flex items-center gap-0.5 text-[11px] px-1 py-0.5 rounded hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
                  style={{ color: "var(--text-muted)", minHeight: 44, marginTop: -11, marginBottom: -11 }}
                >
                  <ChevronRight size={11} aria-hidden="true" className={open ? "rotate-90 transition-transform" : "transition-transform"} />
                  {open ? "Hide files" : `${paths.length} path${paths.length === 1 ? "" : "s"}`}
                </button>
              ) : null}
            </div>
          )}
          {open && paths.length > 0 ? (
            <ul className="mt-1 space-y-0.5 pl-2 border-l" style={{ borderColor: "var(--border-subtle)" }}>
              {paths.slice(0, 40).map((path) => (
                <li key={path} className="font-mono text-[11px] break-all" style={{ color: "var(--text-muted)" }}>
                  {path}
                </li>
              ))}
              {paths.length > 40 ? (
                <li className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                  +{paths.length - 40} more
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
        <time
          className="font-mono text-[10px] shrink-0 pt-1"
          dateTime={event.createdAt}
          style={{ color: "var(--text-muted)" }}
        >
          {clockTime(event.createdAt)}
        </time>
      </div>
    </li>
  );
}

function FactChip({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "danger" | "warning" }) {
  if (!value) return null;
  return (
    <span
      className="badge"
      style={{
        color: tone === "neutral" ? "var(--text-muted)" : toneVar(tone),
        background: "color-mix(in srgb, var(--text-primary) 4%, transparent)",
        height: 22,
        fontSize: 11,
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>{value}</span>
      {label}
    </span>
  );
}

export interface ActivityTimelineProps {
  events: ActivityEvent[];
  run: AgentRun | null;
  facts: RunFacts;
  elapsed: string;
  live: boolean;
  loading: boolean;
  error: string | null;
  onDismissError: () => void;
  budget: ReactNode;
  controls: ReactNode;
  onOpenPreview: () => void;
  hasPreview: boolean;
}

export function ActivityTimeline({
  events,
  run,
  facts,
  elapsed,
  live,
  loading,
  error,
  onDismissError,
  budget,
  controls,
  onOpenPreview,
  hasPreview,
}: ActivityTimelineProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastSeq = events.length > 0 ? events[events.length - 1]?.seq : 0;
  const outcome = outcomeCopy(run);
  const state = stateMeta(run?.state ?? null);

  useEffect(() => {
    scrollToNode(endRef.current);
  }, [lastSeq]);

  const paused = run?.outcome === "paused" || facts.pauseChoices.length > 0;
  const filesTouched = useMemo(() => facts.filesChanged.slice(0, 4), [facts.filesChanged]);

  return (
    <section className="flex flex-col min-h-0 flex-1" style={{ background: "var(--bg-canvas)" }} aria-label="Agent activity">
      <PanelHeader
        title="Activity"
        meta={
          elapsed ? (
            <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }} aria-label="Elapsed time">
              {elapsed}
            </span>
          ) : null
        }
        actions={
          hasPreview ? (
            <IconButton label="Show the preview" onClick={onOpenPreview}>
              <Eye size={16} aria-hidden="true" />
            </IconButton>
          ) : null
        }
      />

      {/*
        Current state — the one place that answers "what is it doing right now".
        It can hold a pause card and the budget meter, so it caps its own height
        and scrolls rather than pushing the timeline out of a short pane.
      */}
      <div
        className="px-3 pt-3 pb-2 space-y-2 shrink-0 border-b overflow-y-auto"
        style={{ borderColor: "var(--border-subtle)", maxHeight: "58%" }}
      >
        <div className="flex items-start gap-2">
          <ToneDot tone={live ? state.tone === "neutral" ? "running" : state.tone : outcome?.tone ?? "neutral"} live={live} size={8} />
          <p className="text-[14px] leading-5 flex-1 min-w-0" style={{ color: "var(--text-primary)", fontWeight: 510 }}>
            {facts.lastAction ?? (live ? state.label : "No run yet")}
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap pl-4">
          <span className="badge" style={{ color: toneVar(live ? state.tone : (outcome?.tone ?? "neutral")), background: "transparent", border: "1px solid var(--border-subtle)", height: 22, fontSize: 11 }}>
            {live ? state.label : (outcome?.label ?? "Idle")}
          </span>
          <FactChip label="files" value={facts.filesChanged.length} />
          <FactChip label="read" value={facts.filesRead} />
          <FactChip label="commands" value={facts.commands} />
          <FactChip label="tests" value={facts.tests} />
          <FactChip label="failures" value={facts.failures} tone="danger" />
          <FactChip label="errors" value={facts.errors} tone="warning" />
        </div>

        {filesTouched.length > 0 ? (
          <ul className="pl-4 flex flex-wrap gap-1" aria-label="Files touched">
            {filesTouched.map((path) => (
              <li
                key={path}
                className="font-mono text-[11px] px-1.5 rounded"
                style={{ color: "var(--text-muted)", background: "color-mix(in srgb, var(--text-primary) 4%, transparent)" }}
                title={path}
              >
                {path.replace(/^\/workspace\//, "")}
              </li>
            ))}
            {facts.filesChanged.length > filesTouched.length ? (
              <li className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                +{facts.filesChanged.length - filesTouched.length} more
              </li>
            ) : null}
          </ul>
        ) : null}

        {error ? <NoticeBar tone="danger" message={error} onDismiss={onDismissError} /> : null}

        {outcome?.reason && !live ? (
          <p className="text-[12px] leading-5 pl-4" style={{ color: toneVar(outcome.tone) }}>
            {outcome.reason}
          </p>
        ) : null}

        {paused ? (
          <div
            className="rounded-md border p-2 space-y-2"
            style={{
              borderColor: "color-mix(in srgb, var(--warning) 28%, transparent)",
              background: "color-mix(in srgb, var(--warning) 7%, transparent)",
            }}
          >
            <p className="text-[12px] leading-5" style={{ color: "var(--text-secondary)" }}>
              {facts.pauseReason ?? outcome?.reason ?? "The agent stopped and is waiting for you."}
            </p>
            {controls}
          </div>
        ) : (
          controls
        )}

        {budget}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" role="log" aria-live="polite" aria-relevant="additions text">
        {loading && events.length === 0 ? (
          <ul className="p-3 space-y-3" aria-label="Loading activity">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="skeleton" style={{ width: 22, height: 22, borderRadius: 6 }} />
                <span className="flex-1 space-y-1.5">
                  <span className="skeleton block" style={{ height: 12, width: `${72 - i * 8}%` }} />
                  <span className="skeleton block" style={{ height: 10, width: `${40 + i * 6}%` }} />
                </span>
              </li>
            ))}
          </ul>
        ) : events.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={18} strokeWidth={1.75} />}
            title="Nothing has run yet"
            hint="Send a request. Every step the agent takes — files it reads, edits it makes, commands and tests it runs — appears here."
          />
        ) : (
          <ol className="py-2">
            {events.map((event, index) => (
              <EventRow key={`${event.runId}-${event.seq}`} event={event} isCurrent={index === events.length - 1 && live} />
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
