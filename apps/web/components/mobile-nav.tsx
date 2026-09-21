"use client";

/**
 * Phone navigation.
 *
 * The workspace has five panes; a phone gets one at a time. Four destinations
 * stay in the bar (chat, activity, code, changes); files, preview and runtime
 * details open as overlays from the top bar, so nothing is squeezed together and
 * nothing is unreachable.
 */

import { Activity, CodeXml, History, MessageSquare } from "lucide-react";

export type MobilePane = "chat" | "activity" | "code" | "changes";

const PANES: Array<{ id: MobilePane; label: string; icon: typeof Activity }> = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "code", label: "Code", icon: CodeXml },
  { id: "changes", label: "Changes", icon: History },
];

export function MobileNav({
  active,
  onChange,
  attention,
}: {
  active: MobilePane;
  onChange: (pane: MobilePane) => void;
  /** Panes with new information get a dot instead of a badge number. */
  attention?: Partial<Record<MobilePane, boolean>>;
}) {
  return (
    <nav
      aria-label="Workspace sections"
      className="flex shrink-0 border-t pb-[env(safe-area-inset-bottom)]"
      style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
    >
      {PANES.map((pane) => {
        const selected = pane.id === active;
        const Icon = pane.icon;
        return (
          <button
            key={pane.id}
            type="button"
            onClick={() => onChange(pane.id)}
            aria-current={selected ? "page" : undefined}
            className="relative flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[52px] transition-colors"
            style={{ color: selected ? "var(--text-primary)" : "var(--text-muted)" }}
          >
            <Icon size={17} strokeWidth={selected ? 2 : 1.6} aria-hidden="true" />
            <span className="text-[10px]" style={{ fontWeight: selected ? 510 : 400 }}>
              {pane.label}
            </span>
            {attention?.[pane.id] ? (
              <span
                aria-hidden="true"
                className="absolute rounded-full"
                style={{ top: 8, right: "calc(50% - 16px)", width: 6, height: 6, background: "var(--accent)" }}
              />
            ) : null}
            {selected ? (
              <span
                aria-hidden="true"
                className="absolute top-0 rounded-full"
                style={{ width: 24, height: 2, background: "var(--accent)" }}
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
