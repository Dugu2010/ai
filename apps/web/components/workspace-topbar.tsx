"use client";

/**
 * Workspace top bar: identity, the one status pill, and the exits (files,
 * preview, details, settings, theme). Below `lg` the icon actions replace the
 * panes that no longer fit.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Eye, Info, LayoutList, Settings } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";
import { IconButton } from "./panel";
import type { PillView } from "./status-pill";
import { StatusPill } from "./status-pill";

export interface WorkspaceTopbarProps {
  projectName: string;
  projectSlug: string;
  pill: PillView;
  elapsed: string;
  meta: ReactNode;
  previewRunning: boolean;
  wide: boolean;
  onOpenFiles: () => void;
  onOpenPreview: () => void;
  onOpenDetails: () => void;
}

export function WorkspaceTopbar({
  projectName,
  projectSlug,
  pill,
  elapsed,
  meta,
  previewRunning,
  wide,
  onOpenFiles,
  onOpenPreview,
  onOpenDetails,
}: WorkspaceTopbarProps) {
  return (
    <header
      className="flex items-center gap-2 px-2 sm:px-3 h-12 shrink-0 border-b"
      style={{ borderColor: "var(--border-color)", background: "var(--bg-panel)" }}
    >
      <Link
        href="/app/projects"
        aria-label="Back to projects"
        title="Back to projects"
        className="hidden sm:inline-flex items-center justify-center rounded-md min-h-[44px] min-w-[44px] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
        style={{ color: "var(--text-muted)" }}
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </Link>

      {!wide ? (
        <IconButton label="Open the file explorer" onClick={onOpenFiles}>
          <LayoutList size={16} aria-hidden="true" />
        </IconButton>
      ) : null}

      <div className="flex items-center gap-2 min-w-0 flex-1">
        <h1 className="text-[14px] truncate" style={{ fontWeight: 590, letterSpacing: "-0.01em" }}>
          {projectName}
        </h1>
        <span className="hidden xl:inline font-mono text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
          {projectSlug}
        </span>
        <StatusPill view={pill} title={wide ? "Agent state. Runtime details are in Status." : "Agent state"} />
        {elapsed ? (
          <span className="hidden md:inline font-mono text-[11px]" style={{ color: "var(--text-muted)" }} aria-label="Elapsed time for the last run">
            {elapsed}
          </span>
        ) : null}
        {meta}
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        {!wide ? (
          <IconButton
            label={previewRunning ? "Open preview (dev server running)" : "Open preview"}
            onClick={onOpenPreview}
            tone={previewRunning ? "success" : "neutral"}
          >
            <Eye size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        {!wide ? (
          <IconButton label="Open runtime and status details" onClick={onOpenDetails}>
            <Info size={16} aria-hidden="true" />
          </IconButton>
        ) : null}
        <Link
          href="/settings"
          aria-label="Open settings"
          title="Settings"
          className="inline-flex items-center justify-center rounded-md min-h-[44px] min-w-[44px] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
          style={{ color: "var(--text-muted)" }}
        >
          <Settings size={16} aria-hidden="true" />
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
