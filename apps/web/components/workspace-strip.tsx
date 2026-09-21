"use client";

/**
 * The bottom strip.
 *
 * The tab row is always on screen — collapsing hides the body, never the way
 * back in — so Changes, Runtime, Preview and Status stay reachable.
 */

import { type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export type StripTab = "changes" | "runtime" | "preview" | "status";

const TABS: Array<{ id: StripTab; label: string }> = [
  { id: "changes", label: "Changes" },
  { id: "runtime", label: "Runtime" },
  { id: "preview", label: "Preview" },
  { id: "status", label: "Status" },
];

export interface WorkspaceStripProps {
  tab: StripTab;
  onTabChange: (tab: StripTab) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  children: ReactNode;
  /** Count or short label rendered next to a tab, e.g. checkpoint count. */
  badges?: Partial<Record<StripTab, string | null>>;
  label?: string;
}

export function WorkspaceStrip({
  tab,
  onTabChange,
  expanded,
  onToggleExpanded,
  children,
  badges,
  label = "Workspace panels",
}: WorkspaceStripProps) {
  /**
   * Roving tabindex: the tablist exposes exactly one tab stop, so arrow keys
   * must move DOM focus as well as selection. Without the explicit focus call
   * the previously selected button keeps focus while dropping to tabIndex -1,
   * and its handler then recomputes the same neighbour — you could never arrow
   * past one tab.
   */
  const move = (from: StripTab, delta: number) => {
    const index = TABS.findIndex((item) => item.id === from);
    const next = TABS[(index + delta + TABS.length) % TABS.length];
    if (!next) return;
    onTabChange(next.id);
    if (!expanded) onToggleExpanded();
    document.getElementById(`strip-tab-${next.id}`)?.focus();
  };

  const jumpTo = (target: StripTab) => {
    onTabChange(target);
    if (!expanded) onToggleExpanded();
    document.getElementById(`strip-tab-${target}`)?.focus();
  };

  return (
    <div
      className="flex flex-col flex-shrink-0 border-t lg:h-auto"
      style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
    >
      <div
        role="tablist"
        aria-label={label}
        className="flex items-center gap-1 px-2 h-11 shrink-0"
        onKeyDown={(event) => {
          if (event.key === "Escape" && expanded) {
            event.preventDefault();
            onToggleExpanded();
          }
        }}
      >
        {TABS.map((item) => {
          const selected = item.id === tab;
          const badge = badges?.[item.id];
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`strip-tab-${item.id}`}
              aria-selected={selected}
              aria-controls="strip-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                onTabChange(item.id);
                if (!expanded) onToggleExpanded();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  move(item.id, 1);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  move(item.id, -1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  jumpTo(TABS[0]!.id);
                } else if (event.key === "End") {
                  event.preventDefault();
                  jumpTo(TABS[TABS.length - 1]!.id);
                }
              }}
              className="relative inline-flex items-center gap-1.5 px-2.5 rounded-md text-[12px] transition-colors min-h-[44px]"
              style={{
                color: selected ? "var(--text-primary)" : "var(--text-muted)",
                background: selected ? "color-mix(in srgb, var(--text-primary) 6%, transparent)" : "transparent",
                fontWeight: selected ? 510 : 400,
              }}
            >
              {item.label}
              {badge ? (
                <span className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
                  {badge}
                </span>
              ) : null}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-controls="strip-panel"
          aria-label={expanded ? "Collapse the panel row" : "Expand the panel row"}
          className="inline-flex items-center gap-1 px-2 rounded-md text-[12px] min-h-[44px] transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
          style={{ color: "var(--text-muted)" }}
        >
          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
          <span className="hidden sm:inline">{expanded ? "Collapse" : "Expand"}</span>
        </button>
      </div>

      {/*
        Collapsing hides the body but keeps it mounted, so a dev-server preview
        does not reload every time the row is folded away.
      */}
      <div
        id="strip-panel"
        role="tabpanel"
        aria-labelledby={`strip-tab-${tab}`}
        hidden={!expanded}
        className="border-t h-[268px] min-h-0"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {children}
      </div>
    </div>
  );
}
