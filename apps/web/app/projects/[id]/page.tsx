"use client";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

export default function ProjectPage() {
  const [project, setProject] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  const projectId = pathname.split("/").pop() || "";

  const fetchProject = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (res.ok) {
        const data = await res.json();
        setProject(data);
        if (data.previewUrl) setPreviewUrl(data.previewUrl);
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/workspace/${projectId}/status`);
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        if (data.previewUrl) setPreviewUrl(data.previewUrl);
      }
    } catch {}
  };

  const fetchFiles = async (path = "/workspace") => {
    try {
      const res = await fetch(`/api/workspace/${projectId}?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data);
      }
    } catch {}
  };

  const fetchFile = async (path: string) => {
    try {
      const res = await fetch(`/api/workspace/${projectId}/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const content = await res.text();
        setFileContent(content);
      }
    } catch {}
  };

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });
      const data = await res.json();
      if (data.message) {
        setMessages((prev) => [...prev, { ...data.message, content: data.content }]);
      }
      setInput("");
      await fetchProject();
      await fetchStatus();
      await fetchFiles();
    } finally {
      setSending(false);
    }
  };

  const saveFile = async () => {
    if (!selectedFile || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/workspace/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", path: selectedFile, content: fileContent }),
      });
      if (res.ok) {
        await fetchFiles();
      }
    } finally {
      setSaving(false);
    }
  };

  const startPreview = async () => {
    if (!project) return;
    try {
      const res = await fetch(`/api/workspace/${projectId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "npm run dev", port: 3000 }),
      });
      if (res.ok) {
        const data = await res.json();
        setPreviewUrl(data.url);
        await fetchStatus();
      }
    } catch {}
  };

  useEffect(() => {
    fetchProject();
  }, [projectId]);

  useEffect(() => {
    if (project) {
      fetchStatus();
      fetchFiles();
    }
  }, [project]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        Loading...
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        Project not found
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="flex h-screen">
        <div className="w-64 border-r border-gray-700 bg-gray-850 flex flex-col">
          <div className="p-4 border-b border-gray-700">
            <h2 className="font-semibold">{project.name}</h2>
            <p className="text-sm text-gray-400">{project.slug}</p>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-2">Files</h3>
            <ul className="space-y-1">
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => {
                      setSelectedFile(f.path);
                      fetchFile(f.path);
                    }}
                    className={`text-left w-full px-2 py-1 rounded text-sm ${
                      selectedFile === f.path ? "bg-blue-600" : "hover:bg-gray-700"
                    }`}
                  >
                    {f.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="p-4 border-t border-gray-700">
            <button
              onClick={startPreview}
              className="w-full px-3 py-2 bg-green-600 rounded hover:bg-green-700 text-sm"
            >
              Start Preview
            </button>
          </div>
        </div>

        <div className="flex-1 flex">
          <div className="flex-1 flex flex-col border-r border-gray-700">
            <div className="p-2 border-b border-gray-700 flex justify-between items-center">
              <span className="text-sm text-gray-400">{selectedFile || "No file selected"}</span>
              <button
                onClick={saveFile}
                disabled={saving || !selectedFile}
                className="px-3 py-1 bg-blue-600 rounded text-sm disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
            <textarea
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              className="flex-1 bg-gray-900 p-4 font-mono text-sm resize-none outline-none"
              placeholder="Select a file to edit..."
            />
          </div>

          <div className="w-96 flex flex-col">
            <div className="flex-1 overflow-auto p-4 space-y-4">
              {messages.map((m, i) => (
                <div key={i} className={`p-3 rounded ${m.role === "user" ? "bg-blue-600" : "bg-gray-800"}`}>
                  <p className="text-sm">{m.content || "Tool call..."}</p>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <div className="p-4 border-t border-gray-700">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                  placeholder="Ask DAI..."
                  className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded"
                />
                <button
                  onClick={sendMessage}
                  disabled={sending}
                  className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {sending ? "..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {previewUrl && (
          <div className="w-96 border-l border-gray-700 bg-gray-850 flex flex-col">
            <div className="p-2 border-b border-gray-700 text-sm text-gray-400">Preview</div>
            <iframe
              src={previewUrl}
              className="flex-1 w-full"
              title="Preview"
            />
          </div>
        )}
      </div>
    </div>
  );
}
