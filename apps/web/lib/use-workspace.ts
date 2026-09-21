"use client";

/**
 * Workspace data: project, runtime status, file tree, open file, preview.
 *
 * Owns the reads the layout needs and nothing about the agent. `use-agent-run`
 * reports a preview URL it sees on the stream through `reportPreviewUrl`, so the
 * iframe has one owner while the run stays the author of the fact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchApi } from "./api-client";
import {
  asArray,
  WORKSPACE_ROOT,
  errorFromResponse,
  requestJson,
  type PreviewStartResult,
  type ProjectResponse,
  type WorkspaceEntry,
  type WorkspaceStatus,
} from "./api-contract";
import type { Project } from "@dai/types";

const ROOT_PATH = WORKSPACE_ROOT;

export interface WorkspaceController {
  project: Project | null;
  projectLoading: boolean;
  projectError: string | null;
  reloadProject: () => Promise<void>;

  status: WorkspaceStatus | null;
  refreshStatus: () => Promise<void>;
  runtimeReady: boolean;

  entries: Record<string, WorkspaceEntry[]>;
  dirLoading: Record<string, boolean>;
  treeError: string | null;
  /** True while the root listing is missing or in flight. */
  rootLoading: boolean;
  loadDir: (path: string) => Promise<void>;
  refreshTree: () => Promise<void>;

  selectedFile: string | null;
  fileContent: string;
  fileLoading: boolean;
  fileError: string | null;
  dirty: boolean;
  selectFile: (path: string) => Promise<void>;
  closeFile: () => void;
  changeFile: (value: string) => void;
  clearFileError: () => void;
  saveFile: () => Promise<void>;

  /** Size of the open file, when the listing reported one. */
  selectedSize: number | null;
  previewUrl: string | null;
  previewBusy: boolean;
  previewError: string | null;
  startPreview: () => Promise<void>;
  stopPreview: () => Promise<void>;
  clearPreviewError: () => void;
  reportPreviewUrl: (url: string | null) => void;

  restartRuntime: () => Promise<void>;
  runtimeBusy: boolean;
}

export function useWorkspace(projectId: string, enabled: boolean): WorkspaceController {
  const [project, setProject] = useState<Project | null>(null);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectError, setProjectError] = useState<string | null>(null);

  const [status, setStatus] = useState<WorkspaceStatus | null>(null);

  const [entries, setEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [dirLoading, setDirLoading] = useState<Record<string, boolean>>({});
  const [treeError, setTreeError] = useState<string | null>(null);
  const openDirsRef = useRef<Set<string>>(new Set<string>([ROOT_PATH]));
  const rootRequestedRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Guards against a slow read for file A landing after the user opened B.
  const fileRequestRef = useRef(0);

  const [streamPreviewUrl, setStreamPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  const loadProject = useCallback(async () => {
    try {
      const data = await requestJson<ProjectResponse>(`/api/projects/${projectId}`);
      if (!data || typeof data !== "object" || !("id" in data)) {
        setProject(null);
        setProjectError("This project no longer exists.");
        return;
      }
      setProject(data as Project);
      setProjectError(null);
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setProjectLoading(false);
    }
  }, [projectId]);

  const loadStatus = useCallback(async (): Promise<WorkspaceStatus | null> => {
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/status`);
      if (!res.ok) return null;
      const data = (await res.json()) as WorkspaceStatus;
      setStatus(data);
      return data;
    } catch {
      // Opportunistic read: keep the last known state rather than flickering.
      return null;
    }
  }, [projectId]);

  const listDir = useCallback(
    async (path: string): Promise<WorkspaceEntry[]> => {
      const res = await fetchApi(`/api/workspace/${projectId}?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(await errorFromResponse(res, "Unable to read this folder"));
      return asArray<WorkspaceEntry>(await res.json().catch(() => []));
    },
    [projectId]
  );

  const loadDir = useCallback(
    async (path: string) => {
      openDirsRef.current.add(path);
      if (path === ROOT_PATH) rootRequestedRef.current = true;
      setDirLoading((prev) => ({ ...prev, [path]: true }));
      try {
        const listed = await listDir(path);
        setEntries((prev) => ({ ...prev, [path]: listed }));
        setTreeError(null);
      } catch (err) {
        setTreeError(err instanceof Error ? err.message : "Unable to read this folder");
      } finally {
        setDirLoading((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
      }
    },
    [listDir]
  );

  /** Re-read the root plus every folder the user has opened. */
  const refreshTree = useCallback(async () => {
    const dirs = [...openDirsRef.current];
    const settled = await Promise.allSettled(dirs.map((dir) => listDir(dir)));
    const collected: Record<string, WorkspaceEntry[]> = {};
    let failure: string | null = null;
    settled.forEach((result, index) => {
      const dir = dirs[index];
      if (result.status === "fulfilled" && dir) collected[dir] = result.value;
      else if (result.status === "rejected") {
        failure = result.reason instanceof Error ? result.reason.message : "Unable to read the workspace";
      }
    });
    if (Object.keys(collected).length > 0) setEntries((prev) => ({ ...prev, ...collected }));
    if (failure) setTreeError(failure);
  }, [listDir]);

  const selectFile = useCallback(
    async (path: string) => {
      const token = ++fileRequestRef.current;
      setSelectedFile(path);
      setFileLoading(true);
      setFileError(null);
      setDirty(false);
      try {
        const res = await fetchApi(`/api/workspace/${projectId}/file?path=${encodeURIComponent(path)}`);
        const text = await res.text();
        if (token !== fileRequestRef.current) return;
        if (!res.ok) {
          setFileContent("");
          setFileError(text || "Unable to open this file");
          return;
        }
        setFileContent(text);
      } catch (err) {
        if (token !== fileRequestRef.current) return;
        setFileError(err instanceof Error ? err.message : "Unable to open this file");
      } finally {
        if (token === fileRequestRef.current) setFileLoading(false);
      }
    },
    [projectId]
  );

  const closeFile = useCallback(() => {
    fileRequestRef.current += 1;
    setSelectedFile(null);
    setFileContent("");
    setFileError(null);
    setDirty(false);
    setFileLoading(false);
  }, []);

  const saveFile = useCallback(async () => {
    if (!selectedFile || !dirty) return;
    try {
      const res = await fetchApi(`/api/workspace/${projectId}`, {
        method: "POST",
        body: JSON.stringify({ action: "write", path: selectedFile, content: fileContent }),
      });
      if (!res.ok) {
        setFileError(await errorFromResponse(res, "Unable to save this file"));
        return;
      }
      setDirty(false);
      setFileError(null);
      await refreshTree();
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Unable to save this file");
    }
  }, [projectId, selectedFile, dirty, fileContent, refreshTree]);

  const startPreview = useCallback(async () => {
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/preview`, {
        method: "POST",
        body: JSON.stringify({ command: "npm run dev", port: 3000 }),
      });
      if (!res.ok) {
        setPreviewError(await errorFromResponse(res, "The dev server did not start"));
        return;
      }
      const data = (await res.json().catch(() => ({}))) as Partial<PreviewStartResult>;
      if (typeof data.url === "string" && data.url) setStreamPreviewUrl(data.url);
      if (data.portUp === false && typeof data.note === "string") setPreviewError(data.note);
      await loadStatus();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "The dev server did not start");
    } finally {
      setPreviewBusy(false);
    }
  }, [projectId, loadStatus]);

  const stopPreview = useCallback(async () => {
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/preview/stop`, { method: "POST" });
      if (!res.ok) setPreviewError(await errorFromResponse(res, "The dev server did not stop"));
      await loadStatus();
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "The dev server did not stop");
    } finally {
      setPreviewBusy(false);
    }
  }, [projectId, loadStatus]);

  const clearPreviewError = useCallback(() => setPreviewError(null), []);

  const reportPreviewUrl = useCallback((url: string | null) => setStreamPreviewUrl(url), []);

  const changeFile = useCallback((value: string) => {
    setFileContent(value);
    setDirty(true);
  }, []);

  const clearFileError = useCallback(() => setFileError(null), []);

  const restartRuntime = useCallback(async () => {
    setRuntimeBusy(true);
    setTreeError(null);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/restart`, { method: "POST" });
      if (!res.ok) {
        setTreeError(await errorFromResponse(res, "The workspace did not come back"));
        return;
      }
      await loadStatus();
      await refreshTree();
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : "The workspace did not come back");
    } finally {
      setRuntimeBusy(false);
    }
  }, [projectId, loadStatus, refreshTree]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    let active = true;
    void (async () => {
      await loadProject();
      if (!active) return;
      const latest = await loadStatus();
      if (!active || latest?.state === "running") return;
      await loadDir(ROOT_PATH);
    })();
    return () => {
      active = false;
    };
  }, [enabled, projectId, loadProject, loadStatus, loadDir]);

  // Reading files needs compute, so the root listing is retried the first time
  // the runtime reports itself as running.
  useEffect(() => {
    if (!enabled || status?.state !== "running" || rootRequestedRef.current) return;
    void (async () => {
      await loadDir(ROOT_PATH);
    })();
  }, [enabled, status?.state, loadDir]);

  const previewUrl = useMemo(
    () => streamPreviewUrl ?? status?.previewUrl ?? project?.previewUrl ?? null,
    [streamPreviewUrl, status?.previewUrl, project?.previewUrl]
  );

  return {
    project,
    projectLoading,
    projectError,
    reloadProject: loadProject,
    status,
    refreshStatus: async () => { await loadStatus(); },
    runtimeReady: status?.state === "running",
    selectedSize: selectedEntrySize(entries, selectedFile),
    entries,
    dirLoading,
    treeError,
    // Only the in-flight read counts as loading: a failed listing must show the
    // empty state and its error, not an endless skeleton.
    rootLoading: Boolean(dirLoading[ROOT_PATH]),
    loadDir,
    refreshTree,
    selectedFile,
    fileContent,
    fileLoading,
    fileError,
    dirty,
    selectFile,
    closeFile,
    changeFile,
    clearFileError,
    saveFile,
    previewUrl,
    previewBusy,
    previewError,
    clearPreviewError,
    startPreview,
    stopPreview,
    reportPreviewUrl,
    restartRuntime,
    runtimeBusy,
  };
}

function selectedEntrySize(
  entries: Record<string, WorkspaceEntry[]>,
  path: string | null
): number | null {
  if (!path) return null;
  for (const list of Object.values(entries)) {
    const hit = list.find((entry) => entry.path === path);
    if (hit) return typeof hit.size === "number" ? hit.size : null;
  }
  return null;
}
