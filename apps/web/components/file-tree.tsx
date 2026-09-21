"use client";

/**
 * File explorer.
 *
 * Folders load their children on demand from `GET /api/workspace/:id?path=`, so
 * opening a project does not walk the whole tree. Files the current run changed
 * are marked from the activity stream — a real set of paths, not a guess.
 */

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, FolderClosed, FolderOpen, RefreshCw } from "lucide-react";
import { WORKSPACE_ROOT, type WorkspaceEntry } from "@/lib/api-contract";
import { EmptyState, IconButton, PanelHeader } from "./panel";
import { Skeleton } from "./loading-skeleton";

interface TreeState {
  entries: Record<string, WorkspaceEntry[]>;
  loading: Record<string, boolean>;
  expanded: Set<string>;
  selectedFile: string | null;
  changed: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function sortEntries(list: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...list].sort((a, b) => {
    const aDir = a.kind === "directory" ? 0 : 1;
    const bDir = b.kind === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

function DirectoryChildren({ path, depth, state }: { path: string; depth: number; state: TreeState }) {
  const children = state.entries[path];
  if (!children || children.length === 0) {
    if (!children) return null;
    return (
      <li style={{ paddingLeft: depth * 12 + 32 }}>
        <p className="text-[11px] py-1" style={{ color: "var(--text-muted)" }}>
          Empty
        </p>
      </li>
    );
  }
  return (
    <>
      {sortEntries(children).map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isOpen = state.expanded.has(entry.path);
        const Icon = isDirectory ? (isOpen ? FolderOpen : FolderClosed) : File;
        const selected = !isDirectory && state.selectedFile === entry.path;
        return (
          <li key={entry.path}>
            <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
              {isDirectory ? (
                <button
                  type="button"
                  onClick={() => state.onToggle(entry.path)}
                  aria-label={isOpen ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                  aria-expanded={isOpen}
                  className="flex items-center justify-center shrink-0"
                  style={{ width: 20, height: 44 }}
                >
                  {state.loading[entry.path] ? (
                    <span className="skeleton" aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3 }} />
                  ) : isOpen ? (
                    <ChevronDown size={12} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
                  )}
                </button>
              ) : (
                <span aria-hidden="true" className="shrink-0" style={{ width: 20 }} />
              )}
              <button
                type="button"
                onClick={() => (isDirectory ? state.onToggle(entry.path) : state.onSelect(entry.path))}
                aria-current={selected ? "true" : undefined}
                className="flex items-center gap-1.5 flex-1 min-w-0 text-left pr-2 rounded transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)]"
                style={{
                  height: 44,
                  background: selected ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined,
                }}
              >
                <Icon size={13} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
                <span
                  className="text-[12.5px] truncate"
                  style={{ color: selected ? "var(--text-primary)" : "var(--text-secondary)" }}
                >
                  {entry.name}
                </span>
                {state.changed.has(entry.path) ? (
                  <span
                    aria-label="changed by this run"
                    title="Changed by this run"
                    className="ml-auto shrink-0 rounded-full"
                    style={{ width: 6, height: 6, background: "var(--accent)" }}
                  />
                ) : null}
              </button>
            </div>
            {isDirectory && isOpen ? (
              <ul>
                <DirectoryChildren path={entry.path} depth={depth + 1} state={state} />
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

export interface FileTreeProps {
  entries: Record<string, WorkspaceEntry[]>;
  loading: Record<string, boolean>;
  selectedFile: string | null;
  changedPaths: readonly string[];
  error: string | null;
  loadingRoot: boolean;
  runtimeReady: boolean;
  onSelect: (path: string) => void;
  onLoadDir: (path: string) => void;
  onRetry: () => void;
}

export function FileTree({
  entries,
  loading,
  selectedFile,
  changedPaths,
  error,
  loadingRoot,
  runtimeReady,
  onSelect,
  onLoadDir,
  onRetry,
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set<string>());
  const changed = useMemo(() => new Set(changedPaths), [changedPaths]);

  const onToggle = useCallback(
    (path: string) => {
      if (expanded.has(path)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }
      setExpanded((prev) => new Set(prev).add(path));
      // Children are fetched once; re-expanding reuses what is already shown.
      if (!entries[path]) void onLoadDir(path);
    },
    [expanded, entries, onLoadDir]
  );

  const rootEntries = entries[WORKSPACE_ROOT] ?? [];
  const state: TreeState = { entries, loading, expanded, selectedFile, changed, onToggle, onSelect };

  return (
    <section className="flex flex-col min-h-0 h-full" aria-label="Files">
      <PanelHeader
        title="Files"
        meta={
          <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
            {rootEntries.length > 0 ? `${rootEntries.length} at root` : ""}
          </span>
        }
        actions={
          <IconButton label="Re-read the file list" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" />
          </IconButton>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {loadingRoot && rootEntries.length === 0 ? (
          <ul className="px-3 space-y-2" aria-label="Loading files">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i}>
                <Skeleton style={{ height: 12, width: `${80 - i * 9}%` }} />
              </li>
            ))}
          </ul>
        ) : rootEntries.length === 0 ? (
          <EmptyState
            icon={<FolderClosed size={18} strokeWidth={1.75} />}
            title={runtimeReady ? "This workspace is empty" : "No files to list yet"}
            hint={
              runtimeReady
                ? "Ask DAI to create something, then re-read the list."
                : "Your files are stored safely. Reading them needs compute, which the agent attaches when it runs."
            }
          />
        ) : (
          <ul>
            <DirectoryChildren path={WORKSPACE_ROOT} depth={0} state={state} />
          </ul>
        )}
        {error ? (
          <p className="px-3 py-2 text-[11px] leading-4" style={{ color: "var(--warning)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
