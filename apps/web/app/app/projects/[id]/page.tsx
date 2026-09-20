"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Editor, { loader } from "@monaco-editor/react";
import { daiDarkTheme, DAI_DARK_THEME_NAME } from "@/lib/monaco-theme";
import { isAuthenticated, fetchApi } from "@/lib/api-client";
import { useToast, showToast } from "@/components/toast";
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
  success: boolean;
  result?: string;
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
  lastError?: string | null;
  bootupType?: string | null;
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

function formatTime(iso?: string): string {
  if (!iso) return "Just now";
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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
            yield { event, data: JSON.parse(data) };
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

// ---------------------------------------------------------------------------
// Activity feed entry
// ---------------------------------------------------------------------------

function ActivityEntry({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const argsSummary = Object.entries(activity.arguments ?? {})
    .slice(0, 2)
    .map(([, v]) => String(v).slice(0, 48))
    .join(" · ");
  return (
    <div className={`command-output ${expanded ? "expanded" : ""}`}>
      <button
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
        style={{ minHeight: 44 }}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: activity.success ? "var(--success)" : "var(--danger)" }}
          />
          <span className="font-mono text-xs flex-shrink-0" style={{ color: "var(--text-secondary)" }}>
            {activity.name}
          </span>
          {argsSummary && (
            <span className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
              {argsSummary}
            </span>
          )}
        </span>
        <span className="text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>
          {expanded ? "Hide" : "Show"}
        </span>
      </button>
      {activity.result && (
        <pre style={{ borderTop: "1px solid var(--border-subtle)", maxHeight: expanded ? "200px" : "96px", overflow: "auto" }}>
          {activity.result}
        </pre>
      )}
    </div>
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
  const [sending, setSending] = useState(false);
  const [fetchingFiles, setFetchingFiles] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [showSidebar, setShowSidebar] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const [isUpToDate, setIsUpToDate] = useState<boolean | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [skeletonLoading, setSkeletonLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  useFocusTrap(drawerRef, showSidebar, () => setShowSidebar(false));

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetchApi(`/api/projects/${projectId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || `Failed to load project (${res.status})`);
      }
      const data = await res.json();
      setProject(data as Project);
      if ((data as any).previewUrl) setPreviewUrl((data as any).previewUrl);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load project");
    } finally {
      setLoading(false);
      setSkeletonLoading(false);
    }
  }, [projectId]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/status`);
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data as Status);
      if ((data as any).previewUrl) setPreviewUrl((data as any).previewUrl);
      if (data.isUpToDate !== undefined) setIsUpToDate(data.isUpToDate);
    } catch {}
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
      const conv = await res.json();
      if (!conv?.id) return;
      const msgRes = await fetchApi(`/api/conversations/${conv.id}/messages`);
      if (!msgRes.ok) return;
      const msgs = await msgRes.json();
      if (Array.isArray(msgs)) {
        setMessages(
          msgs
            .filter((m: any) => m.role === "user" || m.role === "assistant")
            .map((m: any) => ({ id: m.id, role: m.role, content: m.content || "" }))
        );
      }
    } catch {
      // History load failure is non-fatal.
    }
  }, [projectId]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || sending) return;
    const userMessage: Message = { id: Date.now().toString(), role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);

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

      if (!res.ok || !res.body) {
        throw new Error(`Agent request failed (${res.status})`);
      }

      for await (const event of parseSSE(res.body) as any) {
        if (event.event === "tool_call") {
          setActivities((prev) => [
            ...prev,
            {
              id: String(event.data.id),
              name: String(event.data.name),
              arguments: (event.data.args ?? {}) as Record<string, unknown>,
              success: false,
            },
          ]);
        } else if (event.event === "tool_result") {
          setActivities((prev) =>
            prev.map((a: ToolActivity) =>
              a.id === String(event.data.id)
                ? { ...a, success: String(event.data.status) === "success", result: String(event.data.preview ?? "") }
                : a
            )
          );
        } else if (event.event === "assistant_delta") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              return prev.map((m) => (m.id === last.id ? { ...m, content: m.content + (event.data.text ?? "") } : m));
            }
            const id = "stream-" + Date.now();
            return [...prev, { id, role: "assistant" as const, content: (event.data.text ?? "") }];
          });
        } else if (event.event === "error") {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              return prev.map((m) =>
                m.id === last.id ? { ...m, content: m.content + "\n[Error: " + (event.data.message ?? "unknown") + "]" } : m
              );
            }
            return prev;
          });
          showToast(String(event.data.message ?? "Agent error"), "error");
        } else if (event.event === "done") {
          break;
        }
      }

      await fetchProject();
      await fetchStatus();
      await fetchFiles();
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setError(err.message || "Failed to send message");
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant") {
          return prev.map((m) =>
            m.id === last.id ? { ...m, content: m.content + "\n[Error: " + err.message + "]" } : m
          );
        }
        return [...prev, { id: "err-" + Date.now(), role: "assistant", content: "Error: " + err.message }];
      });
    } finally {
      setSending(false);
      abortRef.current = null;
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
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Failed to save", "error");
      }
    } catch (err: any) {
      showToast(err.message || "Failed to save", "error");
    }
  }, [projectId, selectedFile, fileContent, fetchFiles, showToast]);

  const handleRetry = () => {
    setError(null);
    fetchProject();
  };

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
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsNarrowViewport(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (loading || skeletonLoading) {
    return (
      <div className="min-h-screen bg-primary text-primary flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-accent-primary border-t-transparent mx-auto mb-4" />
          <p className="text-muted">Loading project...</p>
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
    <div className="min-h-screen bg-primary text-primary flex flex-col overflow-x-hidden">
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
              <div className="flex-1 overflow-auto p-4">
                <h3 className="text-sm font-medium text-muted mb-2">Files</h3>
                {fetchingFiles ? (
                  <div className="space-y-2">
                    <Skeleton />
                    <Skeleton />
                    <Skeleton />
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {files.map((f) => (
                      <li key={f.path}>
                        <button
                           onClick={() => {
                             setSelectedFile(f.path);
                             fetchFile(f.path);
                             setShowSidebar(false);
                           }}
                          className={`flex items-center gap-2 text-left w-full px-2 py-1.5 min-h-[44px] rounded text-sm transition-colors ${
                            selectedFile === f.path ? "bg-accent-primary" : "hover:bg-secondary"
                          }`}
                        >
                          <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                            {f.name}
                          </span>
                        </button>
                      </li>
                    ))}
                    {files.length === 0 && <li className="text-sm text-muted">No files yet</li>}
                  </ul>
                )}
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
            <div className="flex-1 overflow-auto p-4">
              {fetchingFiles ? (
                <div className="space-y-2">
                  <Skeleton />
                  <Skeleton />
                  <Skeleton />
                </div>
              ) : (
                <ul className="space-y-1">
                  {files.map((f) => (
                    <li key={f.path}>
                      <button
                        onClick={() => {
                          setSelectedFile(f.path);
                          fetchFile(f.path);
                        }}
                        className={`flex items-center gap-2 text-left w-full px-2 py-1.5 min-h-[44px] rounded text-sm transition-colors ${
                          selectedFile === f.path ? "bg-accent-primary" : "hover:bg-secondary"
                        }`}
                      >
                        <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                          {f.name}
                        </span>
                      </button>
                    </li>
                  ))}
                  {files.length === 0 && <li className="text-sm text-muted">No files yet</li>}
                </ul>
              )}
            </div>
          </aside>

          {/* Monaco Editor */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-tertiary">
            {selectedFile ? (
              <>
                <div className="p-2 border-b border-tertiary flex justify-between items-center bg-secondary">
                  <span className="text-sm text-muted truncate font-mono">{selectedFile}</span>
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

          {/* Chat + Activity */}
          <div className="w-full lg:w-[440px] flex flex-col min-h-0 bg-secondary">
            {/* Two columns: conversation left, activity right */}
            <div className="flex-1 min-h-0 flex flex-col md:flex-row">
              {/* Conversation */}
              <div className="flex-1 flex flex-col min-w-0 md:border-r border-tertiary min-h-[50%] md:min-h-0">
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
                            onClick={() => setInput(prompt)}
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
                    <div className="bg-secondary/50 border border-tertiary p-3 rounded-lg text-sm">
                      <div className="flex items-center gap-2">
                        <div className="flex gap-0.5">
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
                <div className="p-3 border-t border-tertiary bg-secondary">
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
                      onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                      placeholder="Ask DAI..."
                      className="flex-1 px-3 min-h-[44px] bg-primary border border-tertiary rounded-lg outline-none focus:border-accent-primary text-sm"
                      disabled={sending}
                    />
                    <button
                      onClick={sendMessage}
                      disabled={sending}
                      aria-label="Send message"
                      className="btn btn-primary px-4 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {sending ? "..." : "Send"}
                    </button>
                  </div>
                </div>
              </div>

              {/* Activity feed */}
              <div className="w-full md:w-56 md:flex-shrink-0 border-t md:border-t-0 border-tertiary bg-primary" style={{ maxHeight: "35%", overflowY: "auto" }}>
                <div className="px-3 py-2 border-b border-tertiary text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                  Activity
                </div>
                <div className="p-2 space-y-1">
                  {activities.length === 0 && (
                    <p className="text-xs text-muted px-2 py-2">No activity yet</p>
                  )}
                  {activities.map((a) => (
                    <ActivityEntry key={a.id} activity={a} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Preview iframe — collapsible */}
        {showPreview && previewUrl && (
          <div className="border-t border-tertiary lg:h-48 flex flex-col transition-all">
            <div className="flex justify-between items-center px-4 py-1.5 bg-secondary border-b border-tertiary cursor-pointer" onClick={() => setShowPreview(false)}>
              <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Preview</span>
              <button className="text-xs" style={{ color: "var(--text-muted)" }}>
                Collapse
              </button>
            </div>
            <iframe src={previewUrl} className="flex-1 w-full bg-white" title="Preview" style={{ minHeight: "120px" }} />
          </div>
        )}
      </div>
    </div>
  );
}
