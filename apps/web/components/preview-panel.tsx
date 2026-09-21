"use client";

/**
 * Live preview of the project's dev server.
 *
 * The URL only ever comes from the run stream or the workspace status, so the
 * iframe never points at something the backend did not report.
 */

import { ExternalLink, Eye, Power } from "lucide-react";
import { EmptyState, NoticeBar, PanelHeader, TextButton } from "./panel";

export interface PreviewPanelProps {
  url: string | null;
  running: boolean;
  busy: boolean;
  error: string | null;
  runtimeReady: boolean;
  onStart: () => void;
  onStop: () => void;
  onDismissError: () => void;
}

export function PreviewPanel({
  url,
  running,
  busy,
  error,
  runtimeReady,
  onStart,
  onStop,
  onDismissError,
}: PreviewPanelProps) {
  const actions = (
    <>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost px-2 text-[12px]"
          style={{ color: "var(--text-secondary)" }}
        >
          <ExternalLink size={13} aria-hidden="true" />
          New tab
        </a>
      ) : null}
      {running || url ? (
        <TextButton variant="ghost" onClick={onStop} busy={busy} className="text-[12px]" title="Stop the dev server">
          <Power size={13} aria-hidden="true" />
          Stop
        </TextButton>
      ) : null}
    </>
  );

  return (
    <section className="flex flex-col min-h-0 h-full" aria-label="Preview">
      <PanelHeader
        title="Preview"
        meta={
          <span className="text-[11px]" style={{ color: running ? "var(--success)" : "var(--text-muted)" }}>
            {running ? "Dev server running" : busy ? "Working…" : "Not running"}
          </span>
        }
        actions={actions}
      />
      {error ? (
        <div className="p-2 shrink-0">
          <NoticeBar tone="warning" message={error} onDismiss={onDismissError} />
        </div>
      ) : null}
      <div className="flex-1 min-h-0" style={{ background: "var(--bg-card)" }}>
        {url ? (
          <iframe
            src={url}
            title="Project preview"
            className="w-full h-full block"
            style={{ border: 0, background: "#ffffff" }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : busy ? (
          <div className="p-4 space-y-2" aria-label="Starting the preview">
            <div className="skeleton" style={{ height: 16, width: "40%" }} />
            <div className="skeleton" style={{ height: 120 }} />
          </div>
        ) : (
          <EmptyState
            icon={<Eye size={18} strokeWidth={1.75} />}
            title="No preview yet"
            hint={
              runtimeReady
                ? "Start the dev server to see the running app here, on its own HTTPS URL."
                : "The agent starts the dev server while it works. You can also start it now."
            }
            action={
              <TextButton variant="secondary" onClick={onStart} busy={busy} className="mt-1">
                <Power size={14} aria-hidden="true" />
                Start dev server
              </TextButton>
            }
          />
        )}
      </div>
    </section>
  );
}
