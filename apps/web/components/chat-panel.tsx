"use client";

/**
 * Chat with the agent. Prose only: tool payloads never appear here — the
 * `ActivityTimeline` owns facts about what the agent did, this panel owns the
 * conversation.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, MessageSquare, Sparkles } from "lucide-react";
import type { ChatEntry } from "@/lib/use-agent-run";
import { EmptyState, PanelHeader } from "./panel";
import { scrollToNode } from "@/lib/motion";

const SUGGESTIONS = ["List the files in this project", "Run the tests and report failures", "Add a README that explains setup"];

function Bubble({ entry }: { entry: ChatEntry }) {
  if (entry.role === "user") {
    return (
      <li className="flex justify-end">
        <div
          className="max-w-[92%] rounded-lg px-3 py-2 text-[13px] leading-5 whitespace-pre-wrap break-words"
          style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
        >
          {entry.content}
        </div>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.08em] pl-0.5" style={{ color: "var(--text-muted)" }}>
        DAI
      </span>
      <div
        className="rounded-lg px-3 py-2 text-[13px] leading-6 whitespace-pre-wrap break-words"
        style={{
          background: entry.pending ? "color-mix(in srgb, var(--accent) 5%, transparent)" : "var(--bg-card)",
          boxShadow: "var(--shadow-ring)",
          color: "var(--text-secondary)",
        }}
      >
        {entry.content || (entry.pending ? "" : "(no response)")}
        {entry.pending && !entry.content ? (
          <span className="flex flex-col gap-1.5" aria-label="DAI is responding">
            <span className="skeleton block" style={{ height: 10, width: "80%" }} />
            <span className="skeleton block" style={{ height: 10, width: "55%" }} />
          </span>
        ) : null}
      </div>
    </li>
  );
}

export interface ChatPanelProps {
  messages: ChatEntry[];
  streaming: boolean;
  loading: boolean;
  modelLabel: string;
  onSend: (text: string) => void;
  /** Contextual controls, e.g. the run controls when the activity pane is off-screen. */
  banner?: ReactNode;
}

export function ChatPanel({ messages, streaming, loading, modelLabel, onSend, banner }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const tail = count > 0 ? messages[count - 1]?.content.length ?? 0 : 0;

  useEffect(() => {
    scrollToNode(endRef.current);
  }, [count, tail]);

  const submit = (text: string) => {
    const value = text.trim();
    if (!value || streaming) return;
    setDraft("");
    onSend(value);
  };

  return (
    <section className="flex flex-col min-h-0 flex-1" style={{ background: "var(--bg-canvas)" }} aria-label="Conversation">
      <PanelHeader
        title="Chat"
        meta={
          modelLabel ? (
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {modelLabel}
            </span>
          ) : null
        }
      />

      {banner ? <div className="px-2 py-2 border-b shrink-0" style={{ borderColor: "var(--border-subtle)" }}>{banner}</div> : null}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {loading && messages.length === 0 ? (
          <ul className="space-y-3" aria-label="Loading conversation">
            {[0, 1].map((i) => (
              <li key={i} className="space-y-1.5">
                <span className="skeleton block" style={{ height: 12, width: `${60 + i * 15}%` }} />
                <span className="skeleton block" style={{ height: 12, width: `${80 - i * 20}%` }} />
              </li>
            ))}
          </ul>
        ) : messages.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={18} strokeWidth={1.75} />}
            title="Start a task"
            hint="Describe the change you want. DAI reads the project, edits files and runs the checks itself."
            action={
              <ul className="mt-2 flex flex-col gap-1.5 w-full">
                {SUGGESTIONS.map((prompt) => (
                  <li key={prompt}>
                    <button
                      type="button"
                      onClick={() => submit(prompt)}
                      className="w-full text-left text-[12px] px-3 py-2 rounded-md border transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]"
                      style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)", minHeight: 44 }}
                    >
                      <Sparkles size={12} aria-hidden="true" className="inline mr-1.5 -mt-0.5" style={{ color: "var(--accent)" }} />
                      {prompt}
                    </button>
                  </li>
                ))}
              </ul>
            }
          />
        ) : (
          <ol className="space-y-3">
            {messages.map((entry) => (
              <Bubble key={entry.id} entry={entry} />
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <div className="p-2 border-t shrink-0" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-panel)" }}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(draft);
          }}
          className="flex items-end gap-2"
        >
          <label htmlFor="agent-prompt" className="sr-only">
            Message DAI
          </label>
          <textarea
            id="agent-prompt"
            value={draft}
            rows={1}
            disabled={streaming}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit(draft);
              }
            }}
            placeholder={streaming ? "Wait for the run to finish, or stop it" : "Ask for a change…"}
            className="input resize-none px-3 py-3 text-[13px] leading-5 max-h-32 disabled:opacity-60"
            style={{ minHeight: 44 }}
          />
          <button
            type="submit"
            disabled={streaming || !draft.trim()}
            aria-label="Send message to DAI"
            className="btn btn-primary shrink-0 min-h-[44px] min-w-[44px] px-3"
          >
            <ArrowUp size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Send</span>
          </button>
        </form>
      </div>
    </section>
  );
}
