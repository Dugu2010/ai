"use client";

import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
import { useRouter, usePathname } from "next/navigation";
import { getToken, fetchAuth } from "../../../lib/auth-client";
import { useToast, showToast } from "../../../components/toast";
import { CommandPalette, getDefaultProjectCommands } from "../../../components/command-palette";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
}

interface Message {
  id: string;
  role: "user" | "assistant" | "streaming";
  content: string;
  status?: "pending" | "complete" | "error";
}

interface Project {
  id: string;
  name: string;
  slug: string;
  status: string;
  previewUrl?: string | null;
}

interface Status {
  state: string;
  previewUrl?: string | null;
  lastActivity?: string;
  agentState?: "idle" | "working" | "thinking";
}

// Tooltip component
function Tooltip({ children, content }: { children: React.ReactNode; content: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-bg-secondary border-border rounded text-xs text-primary whitespace-nowrap z-tooltip">
          {content}
           <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-bg-secondary" />
        </div>
      )}
    </div>
  );
}

// File icon component
function FileIcon({ fileName }: { fileName: string }) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, React.ReactNode> = {
    ts: <span className="text-blue-400 font-bold">TS</span>,
    tsx: <span className="text-blue-400 font-bold">TSX</span>,
    js: <span className="text-yellow-400 font-bold">JS</span>,
    jsx: <span className="text-yellow-400 font-bold">JSX</span>,
    css: <span className="text-purple-400 font-bold">#</span>,
    html: <span className="text-orange-400 font-bold">&lt;&gt;</span>,
    json: <span className="text-green-400 font-bold">{}</span>,
    md: <span className="text-slate-400 font-bold">M</span>,
    py: <span className="text-blue-300 font-bold">py</span>,
    folder: <span className="text-blue-500">📁</span>,
  };
  return icons[ext] || icons.folder;
}

// Agent activity indicator
function AgentIndicator({ state }: { state?: Status["agentState"] }) {
  if (state === "working") {
    return (
      <Tooltip content="Agent is working">
        <div className="flex items-center gap-1.5 text-emerald-400">
          <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-xs font-medium">Working</span>
        </div>
      </Tooltip>
    );
  }
  if (state === "thinking") {
    return (
      <Tooltip content="Agent is thinking">
         <div className="flex items-center gap-1.5 text-accent-primary">
           <div className="flex gap-0.5">
             <div className="w-1.5 h-1.5 bg-accent-primary rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
             <div className="w-1.5 h-1.5 bg-accent-primary rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
             <div className="w-1.5 h-1.5 bg-accent-primary rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
           </div>
          <span className="text-xs font-medium">Thinking</span>
        </div>
      </Tooltip>
    );
  }
  return (
    <Tooltip content="Agent is idle">
        <div className="flex items-center gap-1.5 text-muted">
         <div className="w-2 h-2 bg-muted rounded-full" />
        <span className="text-xs">Idle</span>
      </div>
    </Tooltip>
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
      className={`flex items-center gap-2 px-3 py-2 text-sm border-b-2 transition-colors ${
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

function useAuthRedirect() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const token = getToken();
    if (!token && pathname !== "/auth/login") {
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const fetchProject = useCallback(async () => {
    try {
      const res = await fetchAuth(`/api/projects/${projectId}`);
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
      const res = await fetchAuth(`/api/workspace/${projectId}/status`);
      const data = await res.json();
      setStatus(data as Status);
      if ((data as any).previewUrl) setPreviewUrl((data as any).previewUrl);
    } catch {}
  }, [projectId]);

  const fetchFiles = useCallback(async (path = "/workspace") => {
    setFetchingFiles(true);
    try {
      const res = await fetchAuth(`/api/workspace/${projectId}?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFiles(data as FileEntry[]);
    } catch {}
    finally {
      setFetchingFiles(false);
    }
  }, [projectId]);

  const fetchFile = useCallback(async (path: string) => {
    try {
      const res = await fetchAuth(`/api/workspace/${projectId}/file?path=${encodeURIComponent(path)}`);
      const content = await res.text();
      setFileContent(content);
    } catch {}
  }, [projectId]);

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
      const res = await fetchAuth(`/api/projects/${projectId}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage.content }),
      });
      const data = await res.json();
      if (data.message) {
        // Update streaming message with final content
        setMessages((prev) =>
          prev.map((m) =>
            m.id === streamingId
              ? { ...m, role: "assistant", status: "complete", content: data.message }
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
      const res = await fetchAuth(`/api/workspace/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", path: selectedFile, content: fileContent }),
      });
      if (res.ok) {
        await fetchFiles();
        showToast("File saved successfully", "success");
      }
    } catch (err: any) {
      setError(err.message || "Failed to save file");
      showToast("Failed to save file", "error");
    } finally {
      setSaving(false);
    }
  }, [projectId, selectedFile, saving, fileContent, fetchFiles, showToast]);

  const startPreview = useCallback(async () => {
    if (!project) return;
    try {
      const res = await fetchAuth(`/api/workspace/${projectId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "npm run dev", port: 3000 }),
      });
      if (res.url) {
        setPreviewUrl(res.url);
        await fetchStatus();
        showToast("Preview started", "success");
      }
    } catch {}
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
    }
  }, [project, fetchStatus, fetchFiles]);

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

  if (loading) {
    return (
       <div className="min-h-screen bg-primary text-primary flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent mx-auto mb-4" />
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
            onClick={() => router.push("/")}
            className="px-4 py-2 bg-accent-primary rounded-lg hover:bg-accent-hover transition-colors"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-primary text-primary flex flex-col overflow-x-hidden">
      <CommandPalette projectId={projectId} commands={commands} />
      
      {error && (
        <div className="bg-red-500/10 border-b border-red-500/50 p-3 flex justify-between items-center">
          <span className="text-red-400">{error}</span>
          <button
            onClick={handleRetry}
            className="px-3 py-1 bg-red-600/50 rounded-lg hover:bg-red-600 text-sm transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Status Bar */}
       <div className="bg-secondary border-b border-tertiary px-4 py-1.5 flex justify-between items-center text-xs">
        <div className="flex items-center gap-4">
           <span className="text-muted">Project: {project.name}</span>
          <AgentIndicator state={status?.agentState} />
        </div>
         <div className="flex items-center gap-4 text-muted">
          <span>{status?.state || "Ready"}</span>
          <span>Last activity: {status?.lastActivity || "Just now"}</span>
        </div>
      </div>

      <div ref={overlayRef} className="flex-1 relative">
        {/* Mobile sidebar overlay */}
        {showSidebar && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-black/50" />
            <aside className="absolute left-0 top-0 h-full w-64 max-w-[80vw] bg-primary border-r border-tertiary flex flex-col">
               <div className="p-4 border-b border-tertiary flex justify-between items-center">
                <div>
                  <h2 className="font-semibold">{project.name}</h2>
                   <p className="text-sm text-muted">{project.slug}</p>
                </div>
                <button
                  onClick={() => setShowSidebar(false)}
                   className="p-1 hover:bg-secondary rounded"
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
                           className={`flex items-center gap-2 text-left w-full px-2 py-1.5 rounded text-sm transition-colors ${
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
                  className="w-full px-3 py-2 bg-emerald-600 rounded-lg hover:bg-emerald-700 text-sm transition-colors"
                >
                  Start Preview
                </button>
              </div>
            </aside>
          </div>
        )}

        <div className="flex flex-col lg:flex-row h-full">
          {/* Desktop sidebar */}
          <aside className="hidden lg:block w-64 border-r border-slate-700 bg-slate-850 flex flex-col flex-shrink-0">
            <div className="p-4 border-b border-slate-700">
              <h2 className="font-semibold">{project.name}</h2>
              <p className="text-sm text-slate-400">{project.slug}</p>
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
                           className={`flex items-center gap-2 text-left w-full px-2 py-1.5 rounded text-sm transition-colors ${
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
                    <li className="text-sm text-slate-500">No files yet</li>
                  )}
                </ul>
              )}
            </div>
            <div className="p-4 border-t border-slate-700">
              <button
                onClick={startPreview}
                className="w-full px-3 py-2 bg-emerald-600 rounded-lg hover:bg-emerald-700 text-sm transition-colors"
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
                      <span className="text-sm text-slate-400 truncate font-mono">
                        {selectedFile || "No file selected"}
                      </span>
                    </Tooltip>
                    <button
                      onClick={saveFile}
                      disabled={saving || !selectedFile}
                      className="px-3 py-1 bg-accent-primary rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </div>
                  <textarea
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                        className="flex-1 bg-primary p-4 font-mono text-sm resize-none outline-none"
                    placeholder="Select a file to edit..."
                  />
                </div>
              )}

              {activeTab === "chat" && (
                <div className="flex-1 flex flex-col">
                  <div className="flex-1 overflow-auto p-4 space-y-4">
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className={`p-3 rounded-lg text-sm max-w-[85%] ${
                          m.role === "user"
                        ? "bg-accent-primary self-end"
                        : m.role === "streaming"
                        ? "bg-secondary/50 border border-tertiary"
                        : "bg-secondary"
                        }`}
                      >
                        {m.role === "streaming" ? (
                          <div className="flex items-center gap-2">
                            <div className="flex gap-0.5">
                              <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                              <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                              <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                            </div>
                            <span className="text-muted">Agent is thinking...</span>
                          </div>
                        ) : (
                          <p>{m.content}</p>
                        )}
                      </div>
                    ))}
                    {messages.length === 0 && (
                       <div className="text-center text-muted py-8">
                        <p>Start a conversation with DAI</p>
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
                         className="flex-1 px-3 py-2 bg-primary border border-tertiary rounded-lg outline-none focus:border-accent-primary"
                        disabled={sending}
                      />
                      <button
                        onClick={sendMessage}
                        disabled={sending}
                         className="px-4 py-2 bg-accent-primary rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
                         <p className="text-muted mb-4">No preview running</p>
                        <button
                          onClick={startPreview}
                          className="px-4 py-2 bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors"
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
