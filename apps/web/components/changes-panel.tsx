"use client";

/**
 * Changes and undo.
 *
 * The checkpoint list is what the server stores; the Undo/Redo buttons are
 * enabled only by the `/status` flags, and the result of a restore is reported
 * exactly as the API answered — including `partial` and a blocked 409 with its
 * reason. Nothing here claims a file was restored that the server did not say
 * was restored.
 */

import { useState } from "react";
import { ChevronRight, History, Redo2, Undo2 } from "lucide-react";
import type { CheckpointFile, CheckpointSummary, RestoreReport } from "@/lib/agent-view";
import { restoreTone } from "@/lib/agent-view";
import type { RunFlags } from "@/lib/use-agent-run";
import { dateTime, relativeTime } from "@/lib/format";
import { EmptyState, IconButton, NoticeBar, PanelHeader, TextButton } from "./panel";
import { DiffView } from "./diff-view";
import { Skeleton } from "./loading-skeleton";

const STATUS_COPY: Record<string, string> = {
  applied: "Applied",
  undone: "Undone",
  partial: "Partially reverted",
};

function CheckpointRow({
  checkpoint,
  paths,
  files,
  busy,
  error,
  onOpenFile,
  onExpand,
}: {
  checkpoint: CheckpointSummary;
  paths: string[];
  files: CheckpointFile[] | undefined;
  busy: boolean;
  error: string | null | undefined;
  onOpenFile: (path: string) => void;
  onExpand: (checkpointId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = checkpoint.status === "applied" ? "neutral" : checkpoint.status === "partial" ? "warning" : "accent";
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      // Fetch the stored images only when the row is actually opened, so a
      // project with fifty checkpoints never pulls fifty pre-images.
      if (next) onExpand(checkpoint.id);
      return next;
    });
  };
  const detailPaths = files?.map((file) => file.path);
  const visiblePaths = detailPaths && detailPaths.length > 0 ? detailPaths : paths;

  return (
    <li className="px-3 py-2 border-b last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex-1 min-w-0 text-left"
          style={{ minHeight: 44 }}
        >
          <p className="text-[13px] leading-5 truncate" style={{ color: "var(--text-primary)", fontWeight: 510 }}>
            {checkpoint.label}
          </p>
          <p className="flex items-center gap-1.5 flex-wrap mt-0.5">
            <span className="text-[11px]" style={{ color: `var(--${tone === "neutral" ? "text-muted" : tone === "warning" ? "warning" : "accent"})` }}>
              {STATUS_COPY[checkpoint.status] ?? checkpoint.status}
            </span>
            <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>
              ·
            </span>
            <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
              {checkpoint.fileCount} file{checkpoint.fileCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>
              ·
            </span>
            <time className="font-mono text-[11px]" dateTime={checkpoint.createdAt} title={dateTime(checkpoint.createdAt)} style={{ color: "var(--text-muted)" }}>
              {relativeTime(checkpoint.createdAt) || dateTime(checkpoint.createdAt)}
            </time>
          </p>
        </button>
        {visiblePaths.length > 0 || busy ? (
          <IconButton label={open ? "Hide the changes in this checkpoint" : "Show the changes in this checkpoint"} onClick={toggle}>
            <ChevronRight size={14} aria-hidden="true" className={open ? "rotate-90 transition-transform" : "transition-transform"} />
          </IconButton>
        ) : null}
      </div>

      {checkpoint.note ? (
        <p className="mt-1 text-[11px] leading-4" style={{ color: "var(--text-muted)" }}>
          {checkpoint.note}
        </p>
      ) : null}

      {!checkpoint.reversible ? (
        <p className="mt-1 text-[11px] leading-4" style={{ color: "var(--warning)" }}>
          Cannot be fully reverted — some files were too large to store before the change.
        </p>
      ) : null}

      {open ? (
        <div className="mt-1.5">
          {error ? (
            <NoticeBar tone="danger" message={error} />
          ) : busy && files === undefined ? (
            <ul className="space-y-2 py-1" aria-label="Loading this checkpoint">
              {[0, 1].map((i) => (
                <li key={i} className="space-y-1">
                  <Skeleton style={{ height: 10, width: `${60 - i * 15}%` }} />
                  <Skeleton style={{ height: 8, width: "85%" }} />
                  <Skeleton style={{ height: 8, width: "70%" }} />
                </li>
              ))}
            </ul>
          ) : files && files.length > 0 ? (
            <ul
              className="rounded-md border overflow-hidden"
              style={{ borderColor: "var(--border-subtle)", background: "var(--bg-canvas)" }}
            >
              {files.map((file) => (
                <DiffView key={`${file.path}-${file.changeKind}`} file={file} onOpenFile={onOpenFile} />
              ))}
            </ul>
          ) : (
            <p className="py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
              This checkpoint recorded no files.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function RestoreSummary({ report, onDismiss }: { report: RestoreReport; onDismiss: () => void }) {
  const tone = restoreTone(report.status);
  const heading =
    report.status === "blocked"
      ? (report.message ?? "This checkpoint cannot be reverted.")
      : report.status === "partial"
        ? `Partially reverted: ${report.label}`
        : report.status === "undone"
          ? `Reverted: ${report.label}`
          : `Re-applied: ${report.label}`;

  return (
    <div className="space-y-1.5">
      <NoticeBar tone={tone} message={heading} onDismiss={onDismiss} />
      {report.results.length > 0 ? (
        <ul className="pl-1 space-y-0.5" aria-label="Restore results">
          {report.results.slice(0, 25).map((row) => (
            <li key={`${row.path}-${row.status}`} className="flex items-baseline gap-2 text-[11px]">
              <span
                aria-hidden="true"
                className="inline-block rounded-full shrink-0"
                style={{
                  width: 5,
                  height: 5,
                  background:
                    row.status === "restored"
                      ? "var(--success)"
                      : row.status === "deleted" || row.status === "skipped"
                        ? "var(--warning)"
                        : "var(--danger)",
                }}
              />
              <span className="font-mono break-all" style={{ color: "var(--text-secondary)" }}>
                {row.path.replace(/^\/workspace\//, "")}
              </span>
              <span style={{ color: "var(--text-muted)" }}>{row.status}</span>
              {row.detail ? <span style={{ color: "var(--danger)" }}>{row.detail}</span> : null}
            </li>
          ))}
          {report.results.length > 25 ? (
            <li className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              +{report.results.length - 25} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

export interface ChangesPanelProps {
  checkpoints: CheckpointSummary[];
  flags: RunFlags;
  restore: RestoreReport | null;
  restoreBusy: "undo" | "redo" | null;
  changedPathsByCheckpoint: Map<string, string[]>;
  checkpointFiles: Record<string, CheckpointFile[]>;
  checkpointDetailBusy: Record<string, boolean>;
  checkpointDetailError: Record<string, string | null>;
  onExpandCheckpoint: (checkpointId: string) => void;
  loading: boolean;
  error: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onClearRestore: () => void;
  onOpenFile: (path: string) => void;
}

export function ChangesPanel({
  checkpoints,
  flags,
  restore,
  restoreBusy,
  changedPathsByCheckpoint,
  checkpointFiles,
  checkpointDetailBusy,
  checkpointDetailError,
  onExpandCheckpoint,
  loading,
  error,
  onUndo,
  onRedo,
  onClearRestore,
  onOpenFile,
}: ChangesPanelProps) {
  return (
    <section className="flex flex-col min-h-0 h-full" aria-label="Changes and undo">
      <PanelHeader
        title="Changes"
        meta={
          <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
            {checkpoints.length > 0 ? `${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"}` : ""}
          </span>
        }
        actions={
          <>
            <TextButton
              variant="secondary"
              onClick={onUndo}
              disabled={!flags.canUndo}
              busy={restoreBusy === "undo"}
              title={flags.canUndo ? "Revert the most recent applied checkpoint" : "Nothing to revert"}
            >
              <Undo2 size={14} aria-hidden="true" />
              Undo
            </TextButton>
            <TextButton
              variant="ghost"
              onClick={onRedo}
              disabled={!flags.canRedo}
              busy={restoreBusy === "redo"}
              title={flags.canRedo ? "Re-apply the checkpoint you reverted" : "Nothing to re-apply"}
            >
              <Redo2 size={14} aria-hidden="true" />
              Redo
            </TextButton>
          </>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <div className="p-3">
            <NoticeBar tone="danger" message={error} />
          </div>
        ) : null}

        {restore ? (
          <div className="p-3 border-b" style={{ borderColor: "var(--border-subtle)" }}>
            <RestoreSummary report={restore} onDismiss={onClearRestore} />
          </div>
        ) : null}

        {loading ? (
          <ul className="p-3 space-y-3" aria-label="Loading checkpoints">
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-1.5">
                <Skeleton style={{ height: 12, width: `${70 - i * 10}%` }} />
                <Skeleton style={{ height: 10, width: "40%" }} />
              </li>
            ))}
          </ul>
        ) : checkpoints.length === 0 ? (
          <EmptyState
            icon={<History size={18} strokeWidth={1.75} />}
            title="No changes recorded yet"
            hint="Each run that edits files creates a checkpoint here, so you can revert exactly that change."
          />
        ) : (
          <ul>
            {checkpoints.map((checkpoint) => (
              <CheckpointRow
                key={checkpoint.id}
                checkpoint={checkpoint}
                paths={changedPathsByCheckpoint.get(checkpoint.id) ?? []}
                files={checkpointFiles[checkpoint.id]}
                busy={Boolean(checkpointDetailBusy[checkpoint.id])}
                error={checkpointDetailError[checkpoint.id]}
                onOpenFile={onOpenFile}
                onExpand={onExpandCheckpoint}
              />
            ))}
          </ul>
        )}
      </div>

      <p className="px-3 py-2 text-[11px] leading-4 border-t shrink-0" style={{ borderColor: "var(--border-subtle)", color: "var(--text-muted)" }}>
        Undo restores the files a run changed to what they were before it ran.
      </p>
    </section>
  );
}
