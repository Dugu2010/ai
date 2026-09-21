"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Editor from "@monaco-editor/react";
import { daiDarkTheme, DAI_DARK_THEME_NAME } from "@/lib/monaco-theme";
import { isAuthenticated, fetchApi } from "@/lib/api-client";
import { useToast } from "@/components/toast";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { Skeleton } from "@/components/loading-skeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
}

interface ToolActivity {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  running: boolean;
  success: boolean;
  result?: string;
  startedAt: number;
  durationMs?: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  previewUrl?: string | null;
  lastAccessedAt?: string;
  isUpToDate?: boolean | null;
  sandboxId?: string | null;
}

interface Status {
  state: string;
  previewUrl?: string | null;
  isHibernated?: boolean;
  isArchived?: boolean;
  devServerRunning?: boolean;
  lastError?: string | null;
  bootupType?: string | null;
  isUpToDate?: boolean | null;
  modelId?: string;
}

interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL_LABELS: Record<string, string> = {
  "openai/gpt-oss-20b": "GPT-OSS 20B",
  "openai/gpt-oss-120b": "GPT-OSS 120B",
  "qwen/qwen2.5-coder-32b-instruct": "Qwen 2.5 Coder 32B",
  "meta/llama-3.3-70b": "Llama 3.3 70B",
};

const modelId = process.env.NEXT_PUBLIC_DAI_MODEL ?? "openai/gpt-oss-20b";

function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id.split("/").pop()?.replace(/[-_]/g, " ") ?? id;
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Render an activity line as `name("primary arg"[, secondary])`, spec style. */
function activitySummary(activity: ToolActivity): string {
  const args = activity.arguments ?? {};
  const parts: string[] = [];
  const primary = args.path ?? args.command ?? args.pattern ?? args.oldPath;
  if (typeof primary === "string" && primary) {
    parts.push(`"${primary.slice(0, 60)}"`);
  }
  if (activity.name === "write_file") {
    const content = args.content;
    if (typeof content === "string") {
      const lines = content.split("\n").length;
      parts.push(`${lines} line${lines === 1 ? "" : "s"}`);
    }
  }
  if (activity.name === "start_dev_server" && typeof args.port === "number") {
    parts.length = 0;
    parts.push(`port ${args.port}`);
  }
  return `${activity.name}(${parts.join(", ")})`;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".md": "markdown",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".sh": "shell",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "ini",
  ".xml": "xml",
  ".sql": "sql",
};

function languageForPath(path?: string | null): string | undefined {
  if (!path) return undefined;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return LANGUAGE_BY_EXT[ext];
}

/** Read a wire field as a string without trusting the payload's shape. */
function field(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

interface StoredMessage {
  id: string;
  role: string;
  content: string | null;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: { success?: boolean; result?: string };
}

async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let event = "";
      let data = "";
      for (const line of lines) {
        if (line === "") {
          if (event || data) {
            // A single malformed frame must not abort the rest of the chat run.
            try {
              const parsed = JSON.parse(data) as unknown;
              yield { event, data: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {} };
            } catch {
              // Skip it.
            }
            event = "";
            data = "";
          }
        } else if (line.startsWith("event: ")) {
          event = line.slice(7);
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Sandbox status pill — single source of truth
// ---------------------------------------------------------------------------

// Sandbox status pill — single source of truth, one dot.
// States mirror GET /api/workspace/:id/status `state`, which is derived from
// listRunning() rather than a metadata lookup, so "Running" means the VM is up.
function SandboxPill({ status }: { status: Status | null }) {
  let label = "Idle";
  let color = "var(--text-muted)";
  let bg = "var(--bg-tertiary)";
  if (status?.lastError) {
    label = "Error";
    color = "var(--danger)";
    bg = "color-mix(in srgb, var(--danger) 12%, transparent)";
  } else if (status?.state === "provisioning") {
    label = "Provisioning";
    color = "var(--warning)";
    bg = "color-mix(in srgb, var(--warning) 12%, transparent)";
  } else if (status?.state === "running") {
    label = "Running";
    color = "var(--success)";
    bg = "color-mix(in srgb, var(--success) 12%, transparent)";
  } else if (status?.state === "hibernated") {
    label = "Paused";
    color = "var(--warning)";
    bg = "color-mix(in srgb, var(--warning) 12%, transparent)";
  } else if (status?.state === "archived") {
    label = "Archived";
    color = "var(--warning)";
    bg = "color-mix(in srgb, var(--warning) 12%, transparent)";
  } else if (status?.state === "unknown" || status?.state === "error") {
    label = "Error";
    color = "var(--danger)";
    bg = "color-mix(in srgb, var(--danger) 12%, transparent)";
  }
  return (
    <span className="badge" style={{ background: bg, color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function ActivityMarker({ activity }: { activity: ToolActivity }) {
  if (activity.running) {
    return (
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 animate-pulse" style={{ background: "var(--accent)" }} />
    );
  }
  return (
    <span
      className="text-xs flex-shrink-0 w-3 text-center"
      style={{ color: activity.success ? "var(--success)" : "var(--danger)" }}
      aria-label={activity.success ? "succeeded" : "failed"}
    >
      {activity.success ? "✓" : "✗"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Activity feed entry
// ---------------------------------------------------------------------------

function ActivityEntry({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatDuration(activity.durationMs);
  return (
    <div className={`command-output ${expanded ? "expanded" : ""}`}>
      <button
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
        style={{ minHeight: 44 }}
      >
        <span className="flex items-center gap-2 min-w-0">
          <ActivityMarker activity={activity} />
          <span className="font-mono text-xs truncate" style={{ color: "var(--text-secondary)" }}>
            <span aria-hidden="true">{"→ "}</span>
            {activitySummary(activity)}
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
          {!activity.running && duration && <span>{duration}</span>}
          <span>{expanded ? "Hide" : "Show"}</span>
        </span>
      </button>
      {activity.result && (
        <pre style={{ borderTop: "1px solid var(--border-subtle)" }}>
          {!activity.success && <span style={{ color: "var(--danger)" }}>failed{"\n"}</span>}
          {activity.result}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files panel — shared by the desktop sidebar and the mobile drawer
// ---------------------------------------------------------------------------

function FilesPanel({
  files,
  loading,
  sandboxRunning,
  selectedFile,
  onSelect,
}: {
  files: FileEntry[];
  loading: boolean;
  sandboxRunning: boolean;
  selectedFile: string | null;
  onSelect: (path: string) => void;
}) {
  if (loading || (files.length === 0 && !sandboxRunning)) {
    return (
      <div className="space-y-2">
        <Skeleton style={{ height: 14 }} />
        <Skeleton style={{ height: 14, width: "80%" }} />
        <Skeleton style={{ height: 14, width: "65%" }} />
        <Skeleton style={{ height: 14, width: "90%" }} />
        <p className="text-xs pt-2" style={{ color: "var(--text-muted)" }}>
          Provisioning sandbox…
        </p>
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Empty workspace
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.path}>
          <button
            onClick={() => onSelect(f.path)}
            aria-current={selectedFile === f.path ? "true" : undefined}
            className={`flex items-center gap-2 text-left w-full px-2 py-1.5 min-h-[44px] rounded text-sm transition-colors ${
              selectedFile === f.path ? "bg-accent-primary" : "hover:bg-secondary"
            }`}
          >
            <span className="font-mono text-xs truncate" style={{ color: "var(--text-secondary)" }}>
              {f.kind === "directory" ? "▸ " : "  "}
              {f.name}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProjectPage() {
  const router = useRouter();
  const pathname = usePathname();
  const projectId = pathname.split("/").pop() || "";
  const { showToast } = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [fetchingFiles, setFetchingFiles] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [startingDev, setStartingDev] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activityEndRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Marks the assistant message the current SSE run is streaming into, so
  // deltas never merge into an earlier turn's bubble.
  const streamingMessageIdRef = useRef<string | null>(null);
  useFocusTrap(drawerRef, showSidebar, () => setShowSidebar(false));

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetchApi(`/api/projects/${projectId}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Failed to load project (${res.status})`);
      }
      const data = (await res.json()) as Partial<Project>;
      setProject(data as Project);
      if (data.previewUrl) setPreviewUrl(data.previewUrl);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Failed to load project"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/status`);
      if (!res.ok) return;
      const data = (await res.json()) as Status;
      setStatus(data);
      if (data.previewUrl) setPreviewUrl(data.previewUrl);
    } catch {
      // Status is polled opportunistically; a failed read keeps the last value.
    }
  }, [projectId]);

  const fetchFiles = useCallback(async (path = "/workspace") => {
    setFetchingFiles(true);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        setFiles([]);
        return;
      }
      const data = await res.json();
      setFiles(Array.isArray(data) ? (data as FileEntry[]) : []);
    } catch {
    } finally {
      setFetchingFiles(false);
    }
  }, [projectId]);

  const fetchFile = useCallback(async (path: string) => {
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/file?path=${encodeURIComponent(path)}`);
      const content = await res.text();
      setFileContent(content);
    } catch {}
  }, [projectId]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetchApi(`/api/conversations/${projectId}`);
      if (!res.ok) return;
      const conv = (await res.json()) as { id?: string } | null;
      if (!conv?.id) return;
      const msgRes = await fetchApi(`/api/conversations/${conv.id}/messages`);
      if (!msgRes.ok) return;
      const msgs = (await msgRes.json()) as StoredMessage[];
      if (!Array.isArray(msgs)) return;
      setMessages(
        msgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content ?? "",
          }))
      );
      // The backend persists tool rows alongside the chat, so replay the
      // completed ones — otherwise reloading the page empties the activity pane.
      setActivities(
        msgs
          .filter((m) => m.role === "tool" && m.toolName)
          .map((m) => ({
            id: `hist-${m.id}`,
            name: m.toolName as string,
            arguments: m.toolArgs ?? {},
            running: false,
            success: m.toolResult?.success ?? true,
            result: m.toolResult?.result,
            startedAt: 0,
          }))
      );
    } catch {
      // History load failure is non-fatal.
    }
  }, [projectId]);

  const sendMessage = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || sending) return;
    const userMessage: Message = { id: `user-${Date.now()}`, role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);
    setError(null);
    setFailedMessage(null);
    streamingMessageIdRef.current = null;

    // Cancel any previous SSE connection.
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetchApi(`/api/projects/${projectId}/agent`, {
        method: "POST",
        body: JSON.stringify({ message: userMessage.content }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // The backend answers an unavailable sandbox with structured 503 JSON
        // before any SSE headers, so surface its `error` rather than the status.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Agent request failed (${res.status})`);
      }
      if (!res.body) {
        throw new Error("The agent returned no stream.");
      }

      for await (const event of parseSSE(res.body)) {
        if (event.event === "tool_call") {
          const rawArgs = event.data.args;
          setActivities((prev) => [
            ...prev,
            {
              id: field(event.data.id),
              name: field(event.data.name),
              arguments:
                typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {},
              running: true,
              success: false,
              startedAt: Date.now(),
            },
          ]);
        } else if (event.event === "tool_result") {
          const id = field(event.data.id);
          const statusValue = field(event.data.status);
          const preview = field(event.data.preview);
          setActivities((prev) =>
            prev.map((a: ToolActivity) =>
              a.id === id
                ? {
                    ...a,
                    running: false,
                    success: statusValue === "success",
                    result: preview,
                    durationMs: Date.now() - a.startedAt,
                  }
                : a
            )
          );
        } else if (event.event === "assistant_delta") {
          const chunk = field(event.data.text);
          if (!chunk) continue;
          const activeId = streamingMessageIdRef.current;
          if (activeId) {
            setMessages((prev) =>
              prev.map((m) => (m.id === activeId ? { ...m, content: m.content + chunk } : m))
            );
          } else {
            const id = `assistant-${Date.now()}`;
            streamingMessageIdRef.current = id;
            setMessages((prev) => [...prev, { id, role: "assistant" as const, content: chunk }]);
          }
        } else if (event.event === "error") {
          const message = field(event.data.message, "Agent error");
          setError(message);
          setFailedMessage(userMessage.content);
          setActivities((prev) =>
            prev.map((a) => (a.running ? { ...a, running: false, success: false, durationMs: Date.now() - a.startedAt } : a))
          );
          showToast(message, "error");
        } else if (event.event === "done") {
          break;
        }
      }

      await fetchProject();
      await fetchStatus();
      await fetchFiles();
    } catch (err) {
      if (isAbort(err)) return;
      setError(errorMessage(err, "Failed to send message"));
      setFailedMessage(userMessage.content);
      setActivities((prev) =>
        prev.map((a) => (a.running ? { ...a, running: false, success: false, durationMs: Date.now() - a.startedAt } : a))
      );
    } finally {
      setSending(false);
      abortRef.current = null;
      streamingMessageIdRef.current = null;
    }
  }, [projectId, input, sending, fetchProject, fetchStatus, fetchFiles, showToast]);

  const saveFile = useCallback(async () => {
    if (!selectedFile) return;
    try {
      const res = await fetchApi(`/api/workspace/${projectId}`, {
        method: "POST",
        body: JSON.stringify({ action: "write", path: selectedFile, content: fileContent }),
      });
      if (res.ok) {
        await fetchFiles();
        showToast("File saved", "success");
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        showToast(data.error || "Failed to save", "error");
      }
    } catch (err) {
      showToast(errorMessage(err, "Failed to save"), "error");
    }
  }, [projectId, selectedFile, fileContent, fetchFiles, showToast]);

  const handleRetry = () => {
    setError(null);
    if (failedMessage) {
      const message = failedMessage;
      setFailedMessage(null);
      void sendMessage(message);
      return;
    }
    fetchProject();
  };

  const startDevServer = useCallback(async () => {
    setStartingDev(true);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/preview`, {
        method: "POST",
        body: JSON.stringify({ command: "npm run dev", port: 3000 }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; url?: string; portUp?: boolean };
      if (!res.ok) {
        showToast(data.error || "Failed to start the dev server", "error");
        return;
      }
      if (data.url) setPreviewUrl(data.url);
      setShowPreview(true);
      await fetchStatus();
      showToast(data.portUp ? "Dev server ready" : "Dev server starting", "success");
    } catch (err) {
      showToast(errorMessage(err, "Failed to start the dev server"), "error");
    } finally {
      setStartingDev(false);
    }
  }, [projectId, fetchStatus, showToast]);

  useEffect(() => {
    fetchProject();
  }, [projectId, fetchProject]);

  useEffect(() => {
    if (project) {
      fetchStatus();
      fetchFiles();
    }
  }, [project, fetchStatus, fetchFiles]);

  useEffect(() => {
    loadHistory();
  }, [projectId, loadHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activities]);

  useEffect(() => {
    if (!isAuthenticated()) router.replace("/auth/login");
  }, [router]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsNarrowViewport(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Abandon the in-flight agent stream if the route unmounts mid-run.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-canvas)" }}>
        <div className="flex items-center h-[44px] px-4 border-b" style={{ borderColor: "var(--border-subtle)" }}>
          <Skeleton style={{ width: 180, height: 14 }} />
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="hidden lg:flex w-56 flex-col gap-2 p-4 border-r" style={{ borderColor: "var(--border-subtle)" }}>
            <Skeleton style={{ height: 14 }} />
            <Skeleton style={{ height: 14 }} />
            <Skeleton style={{ height: 14, width: "70%" }} />
            <Skeleton style={{ height: 14 }} />
            <Skeleton style={{ height: 14, width: "85%" }} />
          </div>
          <div className="flex-1 p-4 min-w-0">
            <Skeleton style={{ height: "100%", minHeight: 200 }} />
          </div>
          <div
            className="w-full lg:w-[440px] flex flex-col gap-2 p-4 border-l"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <Skeleton style={{ height: 48 }} />
            <Skeleton style={{ height: 48 }} />
            <Skeleton style={{ height: 48, width: "80%" }} />
          </div>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-primary text-primary flex items-center justify-center p-4">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">Project not found</h2>
          <p className="text-muted mb-6">This project may have been deleted or doesn&apos;t exist.</p>
          <button onClick={() => router.push("/app/projects")} className="btn btn-primary px-6">
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen lg:h-screen flex flex-col overflow-x-hidden lg:overflow-hidden"
      style={{ background: "var(--bg-canvas)" }}
    >
      <CommandPalette projectId={projectId} commands={[]} />

      {error && (
        <div className="p-3 flex justify-between items-center border-b" style={{ background: "color-mix(in srgb, var(--danger) 10%, transparent)", borderColor: "color-mix(in srgb, var(--danger) 35%, transparent)" }}>
          <span style={{ color: "var(--danger)" }}>{error}</span>
          <button onClick={handleRetry} className="btn btn-danger h-9 min-h-0 px-3 text-xs">
            Retry
          </button>
        </div>
      )}

      {/* Status Bar */}
      <div className="bg-secondary border-b border-tertiary px-4 py-1.5 flex justify-between items-center text-xs">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowSidebar(true)}
            aria-label="Open navigation sidebar"
            className="lg:hidden w-11 h-11 -my-2 flex items-center justify-center rounded hover:bg-secondary"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="font-medium truncate max-w-[200px]" style={{ fontWeight: 510 }}>{project.name}</span>
          <SandboxPill status={status} />
          <span className="text-muted hidden md:inline">
            · {relativeTime(project.lastAccessedAt) || "Just now"}
          </span>
        </div>
        <div className="flex items-center gap-4 pr-4 text-muted">
          <ThemeToggle />
        </div>
      </div>

      <div ref={overlayRef} id="main-content" className="flex-1 relative flex flex-col">
        {/* Mobile sidebar overlay */}
        {showSidebar && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0" style={{ background: "rgba(0, 0, 0, 0.5)" }} aria-hidden="true" />
            <aside ref={drawerRef} className="absolute left-0 top-0 h-full w-64 max-w-[80vw] bg-primary border-r border-tertiary flex flex-col">
              <div className="p-4 border-b border-tertiary flex justify-between items-center">
                <div>
                  <h2 className="font-semibold">{project.name}</h2>
                  <p className="text-sm text-muted">{project.slug}</p>
                </div>
                <button
                  onClick={() => setShowSidebar(false)}
                  aria-label="Close sidebar"
                  className="w-11 h-11 flex items-center justify-center hover:bg-secondary rounded"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto p-4">
                <h3 className="text-sm font-medium text-muted mb-2">Files</h3>
                <FilesPanel
                  files={files}
                  loading={fetchingFiles}
                  sandboxRunning={status?.state === "running"}
                  selectedFile={selectedFile}
                  onSelect={(path) => {
                    setSelectedFile(path);
                    fetchFile(path);
                    setShowSidebar(false);
                  }}
                />
              </div>
            </aside>
          </div>
        )}

        {/* Main 3-column layout: Files | Editor | Chat+Activity */}
        <div className="flex flex-col lg:flex-row flex-1 min-h-0">
          {/* Files sidebar */}
          <aside className="hidden lg:flex w-56 border-r bg-secondary flex-col flex-shrink-0">
            <div className="p-4 border-b">
              <h3 className="text-sm font-medium text-muted mb-2">Files</h3>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-4">
              <FilesPanel
                files={files}
                loading={fetchingFiles}
                sandboxRunning={status?.state === "running"}
                selectedFile={selectedFile}
                onSelect={(path) => {
                  setSelectedFile(path);
                  fetchFile(path);
                }}
              />
            </div>
          </aside>

          {/* Monaco Editor */}
          <div className="flex-1 min-h-0 flex flex-col min-w-0 border-r border-tertiary">
            {selectedFile ? (
              <>
                <div className="p-2 border-b border-tertiary flex justify-between items-center gap-2 bg-secondary">
                  <span className="text-sm text-muted truncate font-mono">{selectedFile}</span>
                  <button
                    onClick={saveFile}
                    disabled={isNarrowViewport}
                    title={isNarrowViewport ? "Editor is read-only on small screens" : "Save this file"}
                    className="btn btn-primary h-9 min-h-0 px-3 text-xs shrink-0 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <Editor
                    height="100%"
                    theme={DAI_DARK_THEME_NAME}
                    language={languageForPath(selectedFile)}
                    value={fileContent}
                    onChange={(value) => setFileContent(value ?? "")}
                    beforeMount={(monaco) => {
                      monaco.editor.defineTheme(DAI_DARK_THEME_NAME, daiDarkTheme);
                    }}
                    onMount={(editor, monaco) => {
                      monaco.editor.setTheme(DAI_DARK_THEME_NAME);
                      editor.focus();
                    }}
                    options={{
                      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
                      fontSize: 13,
                      minimap: { enabled: false },
                      readOnly: isNarrowViewport,
                      automaticLayout: true,
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-muted text-sm">Select a file to edit</p>
              </div>
            )}
          </div>

          {/* Chat + Activity — two independently scrolling panes */}
          <div className="w-full lg:w-[440px] flex flex-col min-h-0 bg-secondary">
            <div className="flex-1 min-h-0 flex flex-col md:flex-row">
              {/* Conversation */}
              <div className="flex-1 min-h-0 flex flex-col min-w-0 md:border-r border-tertiary">
                <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                  {messages.length === 0 && !sending && (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-2">
                      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                        Ask DAI to inspect the project, write code, or run commands.
                      </p>
                      <div className="flex flex-wrap justify-center gap-2">
                        {["List the files", "Run the tests", "Add a README"].map((prompt) => (
                          <button
                            key={prompt}
                            onClick={() => void sendMessage(prompt)}
                            disabled={sending}
                            className="btn btn-ghost text-xs"
                            style={{ color: "var(--text-secondary)", border: "1px solid var(--border-subtle)" }}
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {messages.map((m) => (
                    <div key={m.id} className={`flex flex-col gap-1 w-full ${m.role === "user" ? "items-end" : "items-start"}`}>
                      <div
                        className="p-3 rounded-lg text-sm max-w-[95%]"
                        style={
                          m.role === "user"
                            ? { background: "var(--accent-primary)", color: "var(--accent-foreground)" }
                            : { background: "var(--bg-card)" }
                        }
                      >
                        <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                      </div>
                    </div>
                  ))}
                  {sending && (
                    <div className="border border-tertiary p-3 rounded-lg text-sm" style={{ background: "var(--bg-card)" }}>
                      <div className="flex items-center gap-2">
                        <div className="flex gap-0.5" aria-hidden="true">
                          <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--accent-primary)", animationDelay: "0ms" }} />
                          <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--accent-primary)", animationDelay: "150ms" }} />
                          <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--accent-primary)", animationDelay: "300ms" }} />
                        </div>
                        <span style={{ color: "var(--text-muted)" }}>Agent is working…</span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
                {/* Input row */}
                <div className="p-3 border-t border-tertiary bg-secondary shrink-0">
                  <div className="flex gap-2">
                    <span
                      title={`Model: ${modelLabel(modelId)}`}
                      className="hidden sm:inline-flex items-center px-2.5 h-[44px] shrink-0 rounded-lg font-mono text-xs border border-tertiary"
                      style={{ color: "var(--text-muted)", background: "var(--bg-primary)" }}
                    >
                      {modelLabel(modelId)}
                    </span>
                    <input
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendMessage();
                        }
                      }}
                      placeholder="Ask DAI..."
                      className="flex-1 min-w-0 px-3 min-h-[44px] bg-primary border border-tertiary rounded-lg outline-none focus:border-accent-primary text-sm"
                      disabled={sending}
                    />
                    <button
                      onClick={() => void sendMessage()}
                      disabled={sending}
                      aria-label="Send message"
                      className="btn btn-primary px-4 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {sending ? "..." : "Send"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Activity feed — its own scroll pane */}
              <div
                className="h-48 md:h-auto md:w-56 md:flex-shrink-0 flex flex-col min-h-0 border-t md:border-t-0 border-tertiary"
                style={{ background: "var(--bg-canvas)" }}
              >
                <div
                  className="px-3 py-2 border-b border-tertiary text-xs font-medium shrink-0"
                  style={{ color: "var(--text-muted)" }}
                >
                  Activity
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
                  {activities.length === 0 && (
                    <p className="text-xs text-muted px-2 py-2">No activity yet</p>
                  )}
                  {activities.map((a) => (
                    <ActivityEntry key={a.id} activity={a} />
                  ))}
                  {previewUrl && status?.devServerRunning && (
                    <div className="flex items-center gap-2 px-2 py-2 text-xs">
                      <span style={{ color: "var(--success)" }}>✓</span>
                      <span style={{ color: "var(--text-muted)" }}>Ready —</span>
                      <button onClick={() => setShowPreview(true)} className="underline">
                        View Preview
                      </button>
                    </div>
                  )}
                  <div ref={activityEndRef} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Preview — collapsible, and always reachable */}
        <div className="border-t border-tertiary flex flex-col flex-shrink-0">
          <div className="flex justify-between items-center px-4 h-11 gap-2 bg-secondary border-b border-tertiary">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Preview
            </span>
            <div className="flex items-center gap-2">
              {previewUrl && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-ghost h-9 min-h-0 px-3 text-xs"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Open in new tab
                </a>
              )}
              <button
                onClick={() => setShowPreview((p) => !p)}
                aria-expanded={showPreview}
                className="btn btn-ghost h-9 min-h-0 px-3 text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {showPreview ? "Collapse" : "Expand"}
              </button>
            </div>
          </div>
          {showPreview && (
            <div className="h-64 lg:h-48 flex flex-col min-h-0">
              {previewUrl ? (
                <iframe src={previewUrl} className="flex-1 w-full bg-white" title="Preview" />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4 text-center">
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                    No dev server is running yet.
                  </p>
                  <button
                    onClick={() => void startDevServer()}
                    disabled={startingDev || status?.state !== "running"}
                    title={status?.state !== "running" ? "Resume the sandbox first" : undefined}
                    className="btn btn-primary px-4 text-xs disabled:opacity-50"
                  >
                    {startingDev ? "Starting…" : "Start the dev server"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
