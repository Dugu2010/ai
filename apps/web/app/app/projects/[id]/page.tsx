"use client";

import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { useRouter, usePathname } from "next/navigation";
import Editor, { loader } from "@monaco-editor/react";
import { daiDarkTheme, DAI_DARK_THEME_NAME } from "@/lib/monaco-theme";
import { isAuthenticated, fetchApi } from "@/lib/api-client";
import { useToast, showToast } from "@/components/toast";
import { CommandPalette, getDefaultProjectCommands } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { useFocusTrap } from "@/lib/use-focus-trap";

interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
}

interface ToolActivity {
  name: string;
  arguments: Record<string, unknown>;
  success: boolean;
  result?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "streaming";
  content: string;
  status?: "pending" | "complete" | "error";
  toolCalls?: ToolActivity[];
}

interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  previewUrl?: string | null;
}

interface ProjectModel {
  id: string;
  owned_by?: string;
}

interface Status {
  state: string;
  previewUrl?: string | null;
  lastActivity?: string;
  isHibernated?: boolean;
  lastError?: string | null;
  agentState?: "idle" | "working" | "thinking";
}

// Tooltip component
function Tooltip({ children, content }: { children: React.ReactNode; content: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-secondary border rounded text-xs text-primary whitespace-nowrap z-tooltip">
          {content}
           <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-secondary" />
        </div>
      )}
    </div>
  );
}

// File icon component
function FileIcon({ fileName }: { fileName: string }) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, React.ReactNode> = {
    ts: <span className="font-bold" style={{ color: "var(--info)" }}>TS</span>,
    tsx: <span className="font-bold" style={{ color: "var(--info)" }}>TSX</span>,
    js: <span className="font-bold" style={{ color: "var(--warning)" }}>JS</span>,
    jsx: <span className="font-bold" style={{ color: "var(--warning)" }}>JSX</span>,
    css: <span style={{ color: "var(--info)", fontWeight: 590 }}>#</span>,
    html: <span className="font-bold" style={{ color: "var(--warning)" }}>&lt;&gt;</span>,
    json: <span className="font-bold" style={{ color: "var(--success)" }}>{}</span>,
    md: <span style={{ color: "var(--text-muted)", fontWeight: 590 }}>M</span>,
    py: <span className="font-bold" style={{ color: "var(--info)", opacity: 0.8 }}>py</span>,
    folder: <span style={{ color: "var(--accent-primary)" }}>📁</span>,
  };
  return icons[ext] || icons.folder;
}

// Unified sandbox status pill — the ONE status indicator (A4). Client-side
// unification when multiple fields disagree: error > provisioning >
// running/hibernated > idle.
function SandboxPill({ status }: { status: Status | null }) {
  let label = "Idle";
  let color = "var(--text-muted)";
  let bg = "var(--bg-tertiary)";
  if (status?.lastError) {
    label = "Error";
    color = "var(--danger)";
    bg = "color-mix(in srgb, var(--danger) 12%, transparent)";
  } else if (status?.state === "provisioning") {
    label = "Provisioning…";
    color = "var(--warning)";
    bg = "color-mix(in srgb, var(--warning) 12%, transparent)";
  } else if (status?.state === "running" && status?.isHibernated) {
    label = "Hibernated";
  } else if (status?.state === "running") {
    label = "Running";
    color = "var(--success)";
    bg = "color-mix(in srgb, var(--success) 12%, transparent)";
  }
  return (
    <span className="badge" style={{ background: bg, color }} title="Sandbox status">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// Model IDs → display labels (A3). Unknown ids fall back to a prettified id.
const MODEL_LABELS: Record<string, string> = {
  "openai/gpt-oss-20b": "GPT-OSS 20B",
  "openai/gpt-oss-120b": "GPT-OSS 120B",
  "meta/llama-3.3-70b": "Llama 3.3 70B",
};

function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id.split("/").pop()?.replace(/[-_]/g, " ") ?? id;
}

// Compact model dropdown styled after the command palette chrome
// (bg-card + shadow-elevated + border) — replaces the full-width native select
// that used to sit between the chat and the input row.
function ModelPicker({
  models,
  value,
  source,
  disabled,
  onSelect,
}: {
  models: ProjectModel[];
  value: string;
  source: "provider" | "fallback" | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options: ProjectModel[] =
    value && !models.some((m) => m.id === value) ? [{ id: value }, ...models] : models;

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select model"
        className="flex items-center gap-2 px-3 min-h-[44px] rounded-lg border border-tertiary bg-primary text-xs whitespace-nowrap hover:bg-secondary transition-colors disabled:opacity-50"
        title={source === "fallback" ? "Provider unreachable — showing cached list" : "Model used by the agent"}
      >
        <span style={{ color: "var(--text-secondary)" }}>{value ? modelLabel(value) : "Model"}</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Models"
          className="absolute bottom-full right-0 mb-2 w-56 max-h-64 overflow-auto rounded-lg border border-tertiary z-50"
          style={{ background: "var(--bg-card)", boxShadow: "var(--shadow-elevated)" }}
        >
          {options.length === 0 && (
            <p className="px-3 py-3 text-xs" style={{ color: "var(--text-muted)" }}>No models available</p>
          )}
          {options.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === value}
              onClick={() => {
                onSelect(m.id);
                setOpen(false);
              }}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 min-h-[44px] text-left text-xs hover:bg-secondary transition-colors"
              style={{ color: m.id === value ? "var(--accent-primary)" : "var(--text-secondary)" }}
            >
              <span>{modelLabel(m.id)}</span>
              {m.id === value && (
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
          {source === "fallback" && (
            <p className="px-3 py-2 text-[11px] border-t border-tertiary" style={{ color: "var(--warning)" }}>
              Provider unreachable — cached list
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Tab component
function Tab({
  active,
  label,
  icon,
  onClick,
  count,
}: {
  active: boolean;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 min-h-[44px] text-sm border-b-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary ${
        active
          ? "border-accent-primary text-accent-primary bg-accent-primary/10"
          : "border-transparent text-muted hover:text-primary hover:bg-secondary/50"
      }`}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && count > 0 && (
         <span className="px-1.5 py-0.5 bg-tertiary rounded-full text-xs">
          {count}
        </span>
      )}
    </button>
  );
}

// Cursor-style activity item: shows WHAT the agent did (tool + outcome), never
// chain-of-thought. Command output is collapsed by default and expandable.
function ActivityItem({ call }: { call: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const argsSummary = Object.entries(call.arguments ?? {})
    .slice(0, 2)
    .map(([, value]) => String(value).slice(0, 48))
    .join(" · ");
  return (
    <div className={`command-output ${expanded ? "expanded" : ""}`}>
      <button
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
        style={{ minHeight: 44 }}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: call.success ? "var(--success)" : "var(--danger)" }}
          />
          <span className="font-mono text-xs flex-shrink-0" style={{ color: "var(--text-secondary)" }}>
            {call.name}
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
      {call.result && (
        <pre style={{ borderTop: "1px solid var(--border-subtle)" }}>{call.result}</pre>
      )}
    </div>
  );
}

function useAuthRedirect() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthenticated() && pathname !== "/auth/login") {
      router.replace("/auth/login");
    }
  }, [router, pathname]);
}

export default function ProjectPage() {
  useAuthRedirect();
  const { showToast } = useToast();

  const router = useRouter();
  const pathname = usePathname();
  const projectId = pathname.split("/").pop() || "";

  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [fetchingFiles, setFetchingFiles] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [activeTab, setActiveTab] = useState<"files" | "chat" | "preview">("files");
  const [models, setModels] = useState<ProjectModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsSource, setModelsSource] = useState<"provider" | "fallback" | null>(null);
  const [isUpToDate, setIsUpToDate] = useState<boolean | null>(null);
  const [isArchived, setIsArchived] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Below the sm breakpoint the editor degrades to a read-only preview pane.
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Focus trap for the mobile drawer (a11y close-out): Escape closes, Tab
  // cycles inside, focus returns to the hamburger on close.
  const drawerRef = useRef<HTMLElement>(null);
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
    }
  }, [projectId]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/status`);
      if (!res.ok) return; // e.g. 404/409 while VM is provisioning
      const data = await res.json();
      setStatus(data as Status);
      if ((data as any).previewUrl) setPreviewUrl((data as any).previewUrl);
      if (data.isUpToDate !== undefined) setIsUpToDate(data.isUpToDate);
      if (data.isArchived !== undefined) setIsArchived(data.isArchived);
    } catch {}
  }, [projectId]);

  const fetchFiles = useCallback(async (path = "/workspace") => {
    setFetchingFiles(true);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        // VM not provisioned yet (409), project missing (404), etc. — the body
        // is an error object, not a file list. Keep files empty instead of
        // storing a non-array that later crashes files.map().
        setFiles([]);
        return;
      }
      const data = await res.json();
      setFiles(Array.isArray(data) ? (data as FileEntry[]) : []);
    } catch {}
    finally {
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

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetchApi("/api/settings/models");
      if (!res.ok) return;
      const data = await res.json();
      const list: ProjectModel[] = Array.isArray(data?.models) ? data.models : [];
      setModels(list);
      if (data?.source === "provider" || data?.source === "fallback") setModelsSource(data.source);
      // Preselect the account's saved model if the list contains it.
      const settingsRes = await fetchApi("/api/settings");
      if (settingsRes.ok) {
        const s = await settingsRes.json();
        if (s.model && list.some((m) => m.id === s.model)) setSelectedModel(s.model);
      }
    } catch {}
  }, []);

  /** Persist the selected model for this account (used by the agent + new conversations). */
  const saveModel = useCallback(async (modelId: string) => {
    try {
      const res = await fetchApi("/api/settings", {
        method: "POST",
        body: JSON.stringify({ model: modelId }),
      });
      if (!res.ok) throw new Error();
      showToast(`Model set to ${modelId}`, "success");
    } catch {
      showToast("Failed to save model selection", "error");
    }
  }, [showToast]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || sending) return;
    const userMessage: Message = { id: Date.now().toString(), role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);
    
    // Add streaming placeholder
    const streamingId = "stream-" + Date.now();
    setMessages((prev) => [...prev, { id: streamingId, role: "streaming", content: "" }]);
    
    try {
      const res = await fetchApi(`/api/projects/${projectId}/agent`, {
        method: "POST",
        body: JSON.stringify({ message: userMessage.content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Agent request failed (${res.status})`);
      }
      if (data.message) {
        // Update streaming message with final content + activity timeline
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingId
              ? {
                  ...m,
                  role: "assistant",
                  status: "complete",
                  content: data.message,
                  toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : undefined,
                }
              : m
          )
        );
      }
      await fetchProject();
      await fetchStatus();
      await fetchFiles();
    } catch (err: any) {
      setError(err.message || "Failed to send message");
      setMessages((prev) =>
        prev.map((m) =>
          m.id === streamingId ? { ...m, status: "error", content: "Error: " + err.message } : m
        )
      );
    } finally {
      setSending(false);
    }
  }, [projectId, input, sending, fetchProject, fetchStatus, fetchFiles]);

  const saveFile = useCallback(async () => {
    if (!selectedFile || saving) return;
    setSaving(true);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}`, {
        method: "POST",
        body: JSON.stringify({ action: "write", path: selectedFile, content: fileContent }),
      });
      if (res.ok) {
        await fetchFiles();
        showToast("File saved successfully", "success");
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Failed to save file", "error");
      }
    } catch (err: any) {
      setError(err.message || "Failed to save file");
      showToast("Failed to save file", "error");
    } finally {
      setSaving(false);
    }
  }, [projectId, selectedFile, saving, fileContent, fetchFiles, showToast]);

  // Item 3: non-blocking agent-update banner. Restart is user-initiated, never
  // forced. Calls Sandboxes.restart via POST /api/workspace/:id/restart.
  const restartSandbox = useCallback(async () => {
    setRestarting(true);
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/restart`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Restart failed");
      showToast("Sandbox restarting with latest agent", "success");
      await fetchStatus();
    } catch (err: any) {
      showToast(err.message || "Failed to restart sandbox", "error");
    } finally {
      setRestarting(false);
    }
  }, [projectId, fetchStatus, showToast]);

  // Item 9: go through the backend proxy. It explicitly resumes a hibernated
  // sandbox (no automatic HTTP wakeup on the csb.app host), makes sure the dev
  // task is running, waits for the port, then returns a signed host URL.
  // Ref: https://codesandbox.stream/docs/sdk/resume
  const startPreview = useCallback(async () => {
    if (!project) return;
    try {
      const res = await fetchApi(`/api/workspace/${projectId}/preview/proxy`, {
        method: "POST",
        body: JSON.stringify({ port: 3000 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start preview");
      if (data.url) {
        setPreviewUrl(data.url);
        await fetchStatus();
        showToast("Preview started", "success");
      } else {
        showToast("Preview is still warming up — try again in a moment", "info");
      }
    } catch {
      showToast("Failed to start preview", "error");
    }
  }, [project, fetchStatus, showToast]);

  const handleRetry = () => {
    setRetryCount((prev) => prev + 1);
    setLoading(true);
    fetchProject();
  };

  useEffect(() => {
    fetchProject();
  }, [projectId, retryCount, fetchProject]);

  useEffect(() => {
    if (project) {
      fetchStatus();
      fetchFiles();
      fetchModels();
    }
  }, [project, fetchStatus, fetchFiles, fetchModels]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showSidebar && overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        setShowSidebar(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSidebar]);

  const commands = getDefaultProjectCommands(projectId);

  // Monaco theme registration. defineTheme runs when the AMD loader resolves
  // monaco (before any editor mounts); setTheme makes dai-dark the default so
  // no "vs"/"vs-dark" fallback ever renders.
  useEffect(() => {
    loader.init().then((monaco) => {
      monaco.editor.defineTheme(DAI_DARK_THEME_NAME, daiDarkTheme);
      monaco.editor.setTheme(DAI_DARK_THEME_NAME);
    });
  }, []);

  // Track the sm breakpoint (640px) for the read-only editor fallback.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setIsNarrowViewport(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (loading) {
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
           <p className="text-muted mb-6">This project may have been deleted or doesn't exist.</p>
          <button
            onClick={() => router.push("/app/projects")}
            className="btn btn-primary px-6"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-primary text-primary flex flex-col overflow-x-hidden">
      {/* Skip-to-content (a11y 2F) — first focusable element on the page */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] btn btn-primary"
      >
        Skip to content
      </a>
      <CommandPalette projectId={projectId} commands={commands} />
      
      {error && (
        <div className="p-3 flex justify-between items-center border-b" style={{ background: "color-mix(in srgb, var(--danger) 10%, transparent)", borderColor: "color-mix(in srgb, var(--danger) 35%, transparent)" }}>
          <span style={{ color: "var(--danger)" }}>{error}</span>
          <button
            onClick={handleRetry}
            className="btn btn-danger h-9 min-h-0 px-3 text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {isArchived && (
        <div className="p-3 border-b" style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderColor: "color-mix(in srgb, var(--warning) 35%, transparent)" }}>
          <span className="text-sm" style={{ color: "var(--warning)" }}>This project is in cold storage (&gt;7 days since last access). Opening may take up to a minute.</span>
        </div>
      )}

      {isUpToDate === false && (
        <div className="p-3 flex justify-between items-center gap-3 border-b" style={{ background: "color-mix(in srgb, var(--accent-primary) 10%, transparent)", borderColor: "color-mix(in srgb, var(--accent-primary) 35%, transparent)" }}>
          <span className="text-sm" style={{ color: "var(--accent-hover)" }}>Your agent is not up to date. Restart to get latest features?</span>
          <button
            onClick={restartSandbox}
            disabled={restarting}
            className="btn btn-primary h-9 min-h-0 px-3 text-xs whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {restarting ? "Restarting..." : "Restart"}
          </button>
        </div>
      )}

      {/* Status Bar */}
       <div className="bg-secondary border-b border-tertiary px-4 py-1.5 flex justify-between items-center text-xs">
        <div className="flex items-center gap-4">
          {/* Drawer trigger — visible below lg, where the desktop sidebar hides (2F) */}
          <button
            onClick={() => setShowSidebar(true)}
            aria-label="Open navigation sidebar"
            className="lg:hidden w-11 h-11 -my-2 flex items-center justify-center rounded hover:bg-secondary"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
           <Tooltip content={project.name}>
            <span className="text-muted truncate max-w-[240px]">Project: {project.name}</span>
          </Tooltip>
          <SandboxPill status={status} />
        </div>
         <div className="flex items-center gap-4 pr-4 text-muted">
          <span>Last activity: {status?.lastActivity || "Just now"}</span>
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
                     <div className="h-8 bg-tertiary rounded animate-pulse" />
                     <div className="h-8 bg-tertiary rounded animate-pulse" />
                     <div className="h-8 bg-tertiary rounded animate-pulse" />
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {files.map((f) => (
                      <li key={f.path}>
                        <button
                          onClick={() => {
                            setSelectedFile(f.path);
                            fetchFile(f.path);
                            setActiveTab("files");
                            setShowSidebar(false);
                          }}
                           className={`flex items-center gap-2 text-left w-full px-2 py-1.5 min-h-[44px] rounded text-sm transition-colors ${
                             selectedFile === f.path ? "bg-accent-primary" : "hover:bg-secondary"
                          }`}
                        >
                          <FileIcon fileName={f.name} />
                          <span>{f.name}</span>
                        </button>
                      </li>
                    ))}
                    {files.length === 0 && (
                    <li className="text-sm text-muted">No files yet</li>
                    )}
                  </ul>
                )}
              </div>
            <div className="p-4 border-t border-tertiary">
                <button
                  onClick={startPreview}
                  className="btn btn-primary w-full"
                >
                  Start Preview
                </button>
              </div>
            </aside>
          </div>
        )}

        <div className="flex flex-col lg:flex-row flex-1 min-h-0">
          {/* Desktop sidebar */}
          <aside className="hidden lg:flex w-64 border-r bg-secondary flex-col flex-shrink-0">
            <div className="p-4 border-b">
              <h2 className="font-semibold">{project.name}</h2>
              <p className="text-sm text-muted">{project.slug}</p>
            </div>
            <div className="flex-1 overflow-auto p-4">
                   <h3 className="text-sm font-medium text-muted mb-2 flex items-center gap-2">
                <FileIcon fileName="folder" />
                Files
              </h3>
              {fetchingFiles ? (
                <div className="space-y-2">
                      <div className="h-8 bg-tertiary rounded animate-pulse" />
                      <div className="h-8 bg-tertiary rounded animate-pulse" />
                      <div className="h-8 bg-tertiary rounded animate-pulse" />
                </div>
              ) : (
                <ul className="space-y-1">
                  {files.map((f) => (
                    <li key={f.path}>
                      <Tooltip content={f.path}>
                        <button
                          onClick={() => {
                            setSelectedFile(f.path);
                            fetchFile(f.path);
                            setActiveTab("files");
                          }}
                           className={`flex items-center gap-2 text-left w-full px-2 py-1.5 min-h-[44px] rounded text-sm transition-colors ${
                             selectedFile === f.path ? "bg-accent-primary" : "hover:bg-secondary"
                          }`}
                        >
                          <FileIcon fileName={f.name} />
                          <span className="truncate">{f.name}</span>
                        </button>
                      </Tooltip>
                    </li>
                  ))}
                  {files.length === 0 && (
                    <li className="text-sm text-muted">No files yet</li>
                  )}
                </ul>
              )}
            </div>
            <div className="p-4 border-t">
              <button
                onClick={startPreview}
                className="btn btn-primary w-full"
              >
                Start Preview
              </button>
            </div>
          </aside>

          <div className="flex-1 flex flex-col min-w-0">
            {/* Tabs */}
             <div className="flex border-b border-tertiary bg-secondary">
              <Tab
                active={activeTab === "files"}
                label="Files"
                icon={<FileIcon fileName="folder" />}
                onClick={() => setActiveTab("files")}
              />
              <Tab
                active={activeTab === "chat"}
                label="Chat"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>}
                onClick={() => setActiveTab("chat")}
              />
              <Tab
                active={activeTab === "preview"}
                label="Preview"
                icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>}
                onClick={() => {
                  setActiveTab("preview");
                  if (!previewUrl) startPreview();
                }}
              />
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-hidden">
              {activeTab === "files" && (
                <div className="h-full flex flex-col">
                  <div className="p-2 border-b border-tertiary flex justify-between items-center bg-secondary">
                    <Tooltip content={selectedFile || "No file selected"}>
                      <span className="text-sm text-muted truncate font-mono">
                        {selectedFile || "No file selected"}
                      </span>
                    </Tooltip>
                    <button
                      onClick={saveFile}
                      disabled={saving || !selectedFile}
                      className="btn btn-primary h-11 min-h-[44px] px-3 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </div>
                  {status?.state === "provisioning" && files.length === 0 ? (
                    /* A9: never a blank panel while the VM provisions */
                    <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
                      <div className="w-full max-w-xs space-y-2">
                        <div className="skeleton h-8" />
                        <div className="skeleton h-8 ml-6" />
                        <div className="skeleton h-8" />
                        <div className="skeleton h-8 ml-6" />
                      </div>
                      <p className="text-sm" style={{ color: "var(--text-muted)" }}>Provisioning sandbox…</p>
                    </div>
                  ) : isNarrowViewport ? (
                    /* Below sm the editor is a read-only preview (2F). */
                    <pre
                      aria-label="Read-only file preview"
                      className="flex-1 bg-primary p-4 font-mono text-sm overflow-auto whitespace-pre"
                    >
                      {fileContent || "Select a file to edit..."}
                    </pre>
                  ) : (
                    <Editor
                      height="100%"
                      theme={DAI_DARK_THEME_NAME}
                      language={undefined}
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
                        readOnly: false,
                      }}
                    />
                  )}
                </div>
              )}

              {activeTab === "chat" && (
                <div className="flex flex-col h-full min-h-0">
                  <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                    {messages.map((m) => {
                      if (m.role === "streaming") {
                        return (
                          <div key={m.id} className="bg-secondary/50 border border-tertiary p-3 rounded-lg text-sm max-w-[85%]">
                            <div className="flex items-center gap-2">
                              <div className="flex gap-0.5">
                                <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--accent-primary)", animationDelay: "0ms" }} />
                                <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--accent-primary)", animationDelay: "150ms" }} />
                                <div className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: "var(--accent-primary)", animationDelay: "300ms" }} />
                              </div>
                              <span style={{ color: "var(--text-muted)" }}>Agent is working…</span>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={m.id} className={`flex flex-col gap-2 w-full ${m.role === "user" ? "items-end" : "items-start"}`}>
                          {m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0 && (
                            <div className="w-full max-w-[85%] space-y-2">
                              {m.toolCalls.map((call, i) => (
                                <ActivityItem key={`${m.id}-activity-${i}`} call={call} />
                              ))}
                            </div>
                          )}
                          {m.content && (
                            <div
                              className="p-3 rounded-lg text-sm max-w-[85%]"
                              style={
                                m.role === "user"
                                  ? { background: "var(--accent-primary)", color: "var(--accent-foreground)" }
                                  : { background: "var(--bg-card)" }
                              }
                            >
                              <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {messages.length === 0 && (
                      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                        <h2 className="text-lg font-medium text-[var(--text-primary)] mb-2">
                          Ask DAI to modify this project
                        </h2>
                        <p className="text-sm text-[var(--text-muted)] max-w-md mb-6">
                          Try: "Add a button to App.tsx", "Run the tests", or "Explain the file structure"
                        </p>
                        <div className="flex flex-wrap gap-2 justify-center">
                          {["List the files", "Run the tests", "Add a README"].map((prompt) => (
                            <button
                              key={prompt}
                              onClick={() => setInput(prompt)}
                              className="px-3 py-2 text-xs rounded-md border border-[var(--border-subtle)] hover:bg-[var(--bg-card)] text-[var(--text-secondary)]"
                            >
                              {prompt}
                            </button>
                          ))}
                        </div>
                        {status?.state === "provisioning" && (
                          <p className="text-xs mt-6" style={{ color: "var(--warning)" }}>
                            Sandbox is provisioning — the agent can edit files once it is ready.
                          </p>
                        )}
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                  <div className="p-4 border-t border-tertiary bg-secondary">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
                        placeholder="Ask DAI..."
                          className="flex-1 px-3 min-h-[44px] bg-primary border border-tertiary rounded-lg outline-none focus:border-accent-primary"
                        disabled={sending}
                      />
                      <ModelPicker
                        models={models}
                        value={selectedModel}
                        source={modelsSource}
                        disabled={sending}
                        onSelect={(id) => {
                          setSelectedModel(id);
                          if (id) saveModel(id);
                        }}
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
              )}

              {activeTab === "preview" && (
                <div className="flex-1 flex flex-col">
                  {previewUrl ? (
                    <iframe
                      src={previewUrl}
                      className="flex-1 w-full bg-white"
                      title="Preview"
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <div className="text-center">
                         <p className="text-muted mb-4">Start the dev server to see a preview</p>
                        <button
                          onClick={startPreview}
                          className="btn btn-primary px-6"
                        >
                          Start Preview
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes slideIn {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
        .animate-slideIn {
          animation: slideIn 0.2s ease-out;
        }
      `}</style>
    </div>
  );
}
