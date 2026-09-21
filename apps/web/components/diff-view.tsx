"use client";

/**
 * Renders a stored checkpoint's real before/after text.
 *
 * Everything on screen is derived from `content_before` / `content_after` as the
 * server saved them. If a file was too large to store, this says so instead of
 * showing an empty diff that would look like "no changes".
 */

import { useMemo } from "react";
import type { CheckpointFile } from "@/lib/agent-view";
import { diffForFile, diffStats, type DiffLine } from "@/lib/diff";

const KIND_PREFIX: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
};

const KIND_COLOR: Record<DiffLine["kind"], string> = {
  add: "var(--success)",
  remove: "var(--danger)",
  context: "var(--text-muted)",
};

const KIND_BACKGROUND: Record<DiffLine["kind"], string> = {
  add: "var(--diff-add-bg)",
  remove: "var(--diff-remove-bg)",
  context: "transparent",
};

const CHANGE_LABEL: Record<CheckpointFile["changeKind"], string> = {
  create: "added",
  modify: "modified",
  delete: "deleted",
  rename: "renamed",
};

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div
      className="grid grid-cols-[3.5rem_3.5rem_1fr] items-start font-mono text-[11.5px] leading-[1.5]"
      style={{ background: KIND_BACKGROUND[line.kind] }}
    >
      <span
        aria-hidden="true"
        className="select-none pr-1.5 text-right tabular-nums"
        style={{ color: "var(--text-muted)" }}
      >
        {line.oldNumber ?? ""}
      </span>
      <span
        aria-hidden="true"
        className="select-none pr-1.5 text-right tabular-nums"
        style={{ color: "var(--text-muted)" }}
      >
        {line.newNumber ?? ""}
      </span>
      <span className="whitespace-pre-wrap break-all pl-1" style={{ color: KIND_COLOR[line.kind] }}>
        {/* The sign carries the meaning, so colour is never the only signal. */}
        <span aria-hidden="true">{KIND_PREFIX[line.kind]}</span>
        <span className="sr-only">{line.kind === "add" ? "added " : line.kind === "remove" ? "removed " : ""}</span>
        {line.text}
      </span>
    </div>
  );
}

export interface DiffViewProps {
  file: CheckpointFile;
  /** Path may be long; the panel keeps it on one line with a title for the rest. */
  onOpenFile?: (path: string) => void;
}

export function DiffView({ file, onOpenFile }: DiffViewProps) {
  const diff = useMemo(() => diffForFile(file), [file]);
  const hasText =
    file.changeKind === "delete" ? file.contentBefore !== null : file.contentAfter !== null || file.contentBefore !== null;

  return (
    <li className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
        {onOpenFile && hasText ? (
          <button
            type="button"
            onClick={() => onOpenFile(file.path)}
            className="font-mono text-[11px] break-all text-left hover:underline"
            style={{ color: "var(--text-primary)", minHeight: 32 }}
            title={file.path}
          >
            {file.path.replace(/^\/workspace\//, "")}
          </button>
        ) : (
          <span className="font-mono text-[11px] break-all" style={{ color: "var(--text-primary)" }} title={file.path}>
            {file.path.replace(/^\/workspace\//, "")}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
          {CHANGE_LABEL[file.changeKind] ?? file.changeKind} · {diffStats(diff)}
        </span>
      </div>

      {!hasText ? (
        <p className="px-2 pb-2 text-[11px] leading-4" style={{ color: "var(--warning)" }}>
          {file.skipReason
            ? `No text to compare — ${file.skipReason}`
            : "No text was stored for this file, so its contents cannot be shown or compared."}
        </p>
      ) : diff.unchanged ? (
        <p className="px-2 pb-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Recorded with identical contents — no line changes.
        </p>
      ) : (
        <div className="overflow-x-auto border-t" style={{ borderColor: "var(--border-subtle)" }}>
          <ul aria-label={`Changes to ${file.path.replace(/^\/workspace\//, "")}`}>
            {diff.hunks.map((hunk, index) => (
              <li key={`${hunk.oldStart}-${hunk.newStart}-${index}`}>
                {index > 0 ? (
                  <p
                    className="px-2 py-0.5 font-mono text-[10.5px]"
                    style={{ color: "var(--text-muted)", background: "var(--bg-canvas)" }}
                  >
                    ⋮ {hunk.lines.length} lines shown
                  </p>
                ) : null}
                {hunk.lines.map((line, lineIndex) => (
                  <DiffLineRow key={`${line.kind}-${lineIndex}`} line={line} />
                ))}
              </li>
            ))}
          </ul>
          {diff.approximate ? (
            <p className="px-2 py-1.5 text-[11px] leading-4" style={{ color: "var(--warning)" }}>
              This file changed too much to align line by line, so the listing is approximate. The stored contents are
              still exact — open the file to see them.
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
