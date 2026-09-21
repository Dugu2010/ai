"use client";

/**
 * Code surface: Monaco plus its file header.
 *
 * Preserved behaviours from the previous workspace: the custom DAI themes,
 * `automaticLayout`, and a read-only editor below `sm` (a phone cannot drive a
 * code editor safely). The theme follows the app, and ⌘/Ctrl+S saves.
 */

import { useEffect } from "react";
import Editor from "@monaco-editor/react";
import { CodeXml, Save, X } from "lucide-react";
import {
  DAI_DARK_THEME_NAME,
  DAI_LIGHT_THEME_NAME,
  MONACO_FONTS,
  daiDarkTheme,
  daiLightTheme,
} from "@/lib/monaco-theme";
import { useTheme } from "@/lib/use-theme";
import { formatBytes } from "@/lib/format";
import { EmptyState, IconButton, NoticeBar, TextButton } from "./panel";

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

export function languageForPath(path?: string | null): string | undefined {
  if (!path) return undefined;
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  return LANGUAGE_BY_EXT[path.slice(dot).toLowerCase()];
}

export interface EditorPaneProps {
  path: string | null;
  value: string;
  size?: number | null;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onDismissError: () => void;
  onClose: () => void;
}

export function EditorPane({
  path,
  value,
  size,
  loading,
  error,
  dirty,
  readOnly,
  onChange,
  onSave,
  onDismissError,
  onClose,
}: EditorPaneProps) {
  const { isDark } = useTheme();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!readOnly && dirty) onSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSave, readOnly, dirty]);

  return (
    <section className="flex flex-col min-h-0 h-full min-w-0" aria-label="Code editor">
      <div
        className="flex items-center justify-between gap-2 px-3 h-11 shrink-0 border-b"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-panel)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <CodeXml size={14} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
          <span className="font-mono text-[12px] truncate" style={{ color: "var(--text-secondary)" }}>
            {path ? path.replace(/^\/workspace\//, "") : "No file open"}
          </span>
          {dirty ? (
            <span className="badge" style={{ color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)", height: 20, fontSize: 11 }}>
              unsaved
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {typeof size === "number" && size > 0 ? (
            <span className="hidden sm:inline font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
              {formatBytes(size)}
            </span>
          ) : null}
          {readOnly ? (
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Read-only
            </span>
          ) : (
            <TextButton variant="secondary" onClick={onSave} disabled={!dirty} title={dirty ? "Save this file (⌘S)" : "No changes to save"} className="text-[12px]">
              <Save size={13} aria-hidden="true" />
              Save
            </TextButton>
          )}
          {path ? (
            <IconButton label="Close this file" onClick={onClose}>
              <X size={14} aria-hidden="true" />
            </IconButton>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="p-2 border-b shrink-0" style={{ borderColor: "var(--border-subtle)" }}>
          <NoticeBar tone="danger" message={error} onDismiss={onDismissError} />
        </div>
      ) : null}

      <div className="flex-1 min-h-0 relative">
        {!path ? (
          loading ? (
            <div className="p-4 space-y-2" aria-label="Loading file">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton" style={{ height: 10, width: `${40 + ((i * 13) % 55)}%` }} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<CodeXml size={18} strokeWidth={1.75} />}
              title="Select a file"
              hint="Pick a file from the explorer to read or edit it. Everything DAI changes is listed in the activity timeline."
            />
          )
        ) : (
          <Editor
            height="100%"
            theme={isDark ? DAI_DARK_THEME_NAME : DAI_LIGHT_THEME_NAME}
            language={languageForPath(path)}
            value={value}
            loading={<div className="p-4 space-y-2"><div className="skeleton" style={{ height: 10, width: "60%" }} /><div className="skeleton" style={{ height: 10, width: "40%" }} /></div>}
            onChange={(next) => onChange(next ?? "")}
            beforeMount={(monaco) => {
              monaco.editor.defineTheme(DAI_DARK_THEME_NAME, daiDarkTheme);
              monaco.editor.defineTheme(DAI_LIGHT_THEME_NAME, daiLightTheme);
            }}
            onMount={(editor, monaco) => {
              monaco.editor.setTheme(isDark ? DAI_DARK_THEME_NAME : DAI_LIGHT_THEME_NAME);
              editor.focus();
            }}
            options={{
              ...MONACO_FONTS,
              minimap: { enabled: false },
              readOnly,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderLineHighlight: readOnly ? "none" : "line",
              smoothScrolling: false,
              padding: { top: 12, bottom: 12 },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              overviewRulerLanes: 0,
              lineNumbersMinChars: 3,
              glyphMargin: false,
              folding: false,
              fontSize: 13,
            }}
          />
        )}
      </div>
    </section>
  );
}
