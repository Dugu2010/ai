"use client";

/**
 * One owner for everything the agent run means: the SSE timeline, the durable
 * `/status` read that survives a refresh, the transcript, run controls and the
 * undo/redo endpoints. The page stays declarative because this hook keeps the
 * sequencing.
 *
 * Honesty rules enforced here:
 *  - Events are stored exactly as the backend wrote them, ordered by `seq`.
 *  - A refresh reloads the same events the server persisted, never a summary.
 *  - Undo/redo report the server's status verbatim, including `partial`/`blocked`.
 *  - No event, count or progress percentage is ever generated client-side.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityEvent, AgentRun, ChatMessage, Conversation, RunStatus } from "@dai/types";
import { fetchApi } from "./api-client";
import { errorFromResponse, requestJson } from "./api-contract";
import { parseSseStream, readString, type SseFrame } from "./sse";
import {
  checkpointPathMap,
  deriveRunFacts,
  elapsedLabelOf,
  isLiveRun,
  parseActivityEvent,
  parseCheckpointFiles,
  parseRestoreReport,
  type CheckpointFile,
  type CheckpointSummary,
  type RestoreReport,
  type RunFacts,
} from "./agent-view";

const CONTINUE_PROMPT = "Continue from where you stopped. Do not repeat work that is already finished.";
const RETRY_PROMPT =
  "Take a materially different approach to the last request. Do not repeat the step that just failed.";

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** True while its `assistant_delta` frames are still arriving. */
  pending: boolean;
}

export interface RunFlags {
  canUndo: boolean;
  canRedo: boolean;
  canContinue: boolean;
  canRetryDifferently: boolean;
}

export interface UseAgentRunOptions {
  projectId: string;
  enabled: boolean;
  /** Called whenever the workspace on disk may have changed (run or undo). */
  onWorkspaceChanged?: () => void | Promise<void>;
  /** Called when the stream reports a preview URL, so the iframe can follow. */
  onPreviewUrl?: (url: string) => void | Promise<void>;
  onNotice?: (message: string, tone: "error" | "success" | "info") => void;
}

export interface AgentRunController {
  run: AgentRun | null;
  events: ActivityEvent[];
  facts: RunFacts;
  changedPathsByCheckpoint: Map<string, string[]>;
  limits: RunStatus["limits"] | null;
  flags: RunFlags;
  checkpoints: CheckpointSummary[];
  /** Stored pre/post images per checkpoint, fetched only when one is expanded. */
  checkpointFiles: Record<string, CheckpointFile[]>;
  checkpointDetailBusy: Record<string, boolean>;
  checkpointDetailError: Record<string, string | null>;
  loadCheckpointDetail: (checkpointId: string) => Promise<void>;
  restore: RestoreReport | null;
  messages: ChatEntry[];
  conversationId: string | null;
  modelId: string;
  streaming: boolean;
  live: boolean;
  statusLoading: boolean;
  checkpointsLoading: boolean;
  restoreBusy: "undo" | "redo" | null;
  agentError: string | null;
  statusError: string | null;
  checkpointsError: string | null;
  elapsed: string;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  continueRun: () => Promise<void>;
  retryDifferently: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  refresh: () => Promise<void>;
  dismissError: () => void;
  clearRestore: () => void;
}

const EMPTY_FLAGS: RunFlags = {
  canUndo: false,
  canRedo: false,
  canContinue: false,
  canRetryDifferently: false,
};

/**
 * `seq` is the ordering the backend guarantees, per run. A frame from a newer
 * run therefore starts a fresh timeline rather than sorting below the old one.
 */
function mergeEvent(current: ActivityEvent[], incoming: ActivityEvent): ActivityEvent[] {
  for (const event of current) {
    if (event.runId === incoming.runId && event.seq === incoming.seq) return current;
  }
  const sameRun = current.filter((event) => event.runId === incoming.runId);
  if (sameRun.length === 0) return [incoming];
  return [...sameRun, incoming].sort((a, b) => a.seq - b.seq);
}

/**
 * A run's first frame carries everything needed to show it: id, start time and
 * prompt. Counts are zero because at that moment they are zero — the terminal
 * `/status` read replaces this with the authoritative record.
 */
function provisionalRun(event: ActivityEvent): AgentRun {
  return {
    id: event.runId,
    projectId: "",
    conversationId: null,
    prompt: readString(event.detail.prompt),
    state: event.state ?? "queued",
    outcome: null,
    stopReason: null,
    counts: {
      iterations: 0,
      toolCalls: 0,
      execCalls: 0,
      runtimeActivations: 0,
      runtimeMs: 0,
      filesChanged: 0,
    },
    sandboxId: null,
    summary: null,
    lastError: null,
    createdAt: event.createdAt,
    finishedAt: null,
  };
}

function toChatEntry(message: ChatMessage): ChatEntry | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const content = typeof message.content === "string" ? message.content : "";
  if (!content.trim()) return null;
  return { id: message.id, role: message.role, content, createdAt: message.createdAt, pending: false };
}

type FrameResult = "ignored" | "assistant" | "done";

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function useAgentRun(options: UseAgentRunOptions): AgentRunController {
  const { projectId, enabled } = options;

  const [run, setRun] = useState<AgentRun | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [limits, setLimits] = useState<RunStatus["limits"] | null>(null);
  const [flags, setFlags] = useState<RunFlags>(EMPTY_FLAGS);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [restore, setRestore] = useState<RestoreReport | null>(null);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [checkpointsLoading, setCheckpointsLoading] = useState(true);
  const [restoreBusy, setRestoreBusy] = useState<"undo" | "redo" | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checkpointsError, setCheckpointsError] = useState<string | null>(null);
  const [checkpointFiles, setCheckpointFiles] = useState<Record<string, CheckpointFile[]>>({});
  const [checkpointDetailBusy, setCheckpointDetailBusy] = useState<Record<string, boolean>>({});
  const [checkpointDetailError, setCheckpointDetailError] = useState<Record<string, string | null>>({});
  const [now, setNow] = useState(() => Date.now());

  const abortRef = useRef<AbortController | null>(null);
  const checkpointDetailRef = useRef<Set<string>>(new Set());
  const streamMessageRef = useRef<string | null>(null);
  // The run record's prompt is truncated by the backend; the browser keeps the
  // full text of the request it sent, which is what "retry differently" needs.
  const lastUserPromptRef = useRef<string | null>(null);
  // The page passes fresh inline callbacks every render; a ref keeps the
  // callbacks out of the effect and dependency lists without being read as
  // render state.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  /* ---- Reads ------------------------------------------------------------- */

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const data = await requestJson<RunStatus>(`/api/projects/${projectId}/agent/status`);
      const nextRun = data && typeof data === "object" ? (data.run ?? null) : null;
      setRun(nextRun);
      setEvents(Array.isArray(data?.events) ? [...data.events].sort((a, b) => a.seq - b.seq) : []);
      if (data?.limits) setLimits(data.limits);
      setFlags({
        canUndo: Boolean(data?.canUndo),
        canRedo: Boolean(data?.canRedo),
        canContinue: Boolean(data?.canContinue),
        canRetryDifferently: Boolean(data?.canRetryDifferently),
      });
      setStatusError(null);
      if (nextRun?.conversationId) setConversationId(nextRun.conversationId);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Unable to read the agent status");
    } finally {
      setStatusLoading(false);
    }
  }, [projectId]);

  const loadCheckpoints = useCallback(async () => {
    setCheckpointsLoading(true);
    // Any restore changes what a checkpoint means, so a cached diff would be a
    // stale claim about the files. Drop it and let the next expand refetch.
    checkpointDetailRef.current = new Set();
    setCheckpointFiles({});
    try {
      const data = await requestJson<{ checkpoints?: CheckpointSummary[] }>(`/api/workspace/${projectId}/checkpoints`);
      setCheckpoints(Array.isArray(data?.checkpoints) ? data.checkpoints : []);
      setCheckpointsError(null);
    } catch (err) {
      setCheckpointsError(err instanceof Error ? err.message : "Unable to read checkpoints");
    } finally {
      setCheckpointsLoading(false);
    }
  }, [projectId]);

  /**
   * Fetch one checkpoint's stored images. Summaries deliberately omit them, so
   * this is the only way to show a real diff — and it runs on demand, on a
   * Postgres read, so it never costs a Sandbox or a provider credit.
   */
  const loadCheckpointDetail = useCallback(
    async (checkpointId: string) => {
      if (!checkpointId || checkpointDetailRef.current.has(checkpointId)) return;
      checkpointDetailRef.current.add(checkpointId);
      setCheckpointDetailBusy((prev) => ({ ...prev, [checkpointId]: true }));
      try {
        const data = await requestJson<unknown>(`/api/workspace/${projectId}/checkpoints/${checkpointId}`);
        setCheckpointFiles((prev) => ({ ...prev, [checkpointId]: parseCheckpointFiles(data) }));
        setCheckpointDetailError((prev) => ({ ...prev, [checkpointId]: null }));
      } catch (err) {
        // Allow a retry after a failure instead of caching the empty result.
        checkpointDetailRef.current.delete(checkpointId);
        setCheckpointDetailError((prev) => ({
          ...prev,
          [checkpointId]: err instanceof Error ? err.message : "Unable to read this checkpoint's changes",
        }));
      } finally {
        setCheckpointDetailBusy((prev) => ({ ...prev, [checkpointId]: false }));
      }
    },
    [projectId]
  );

  const loadTranscript = useCallback(async () => {
    try {
      const conversation = await requestJson<Conversation | null>(`/api/conversations/${projectId}`);
      if (!conversation?.id) {
        setMessages([]);
        return;
      }
      setConversationId(conversation.id);
      setModelId(conversation.model ?? "");
      const rows = await requestJson<ChatMessage[]>(`/api/conversations/${conversation.id}/messages`);
      const entries = (Array.isArray(rows) ? rows : [])
        .map(toChatEntry)
        .filter((entry): entry is ChatEntry => entry !== null);
      setMessages((previous) => {
        // Keep an optimistic in-flight turn that the API has not written yet.
        const serverIds = new Set(entries.map((entry) => entry.id));
        const optimistic = previous.filter((entry) => entry.pending || !serverIds.has(entry.id));
        const merged = [...entries];
        for (const entry of optimistic) {
          if (!merged.some((item) => item.id === entry.id)) merged.push(entry);
        }
        return merged.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      });
    } catch {
      // A missing transcript is not a workspace error; the timeline still loads.
    }
  }, [projectId]);

  /* ---- Stream ------------------------------------------------------------ */

  const applyFrame = useCallback((frame: SseFrame): FrameResult => {
    if (frame.event === "activity") {
      const event = parseActivityEvent(frame.data);
      if (!event) return "ignored";
      setEvents((prev) => mergeEvent(prev, event));
      if (event.type === "agent.started") {
        setRun(provisionalRun(event));
      } else {
        setRun((prev) => (prev && prev.id === event.runId ? { ...prev, state: event.state ?? prev.state } : prev));
      }
      if (event.type === "agent.preview.ready") {
        const url = readString(event.detail.url);
        if (url) void optionsRef.current.onPreviewUrl?.(url);
      }
      return "ignored";
    }
    if (frame.event === "assistant_delta") {
      const chunk = readString(frame.data.text);
      if (!chunk) return "ignored";
      const activeId = streamMessageRef.current;
      if (activeId) {
        setMessages((prev) =>
          prev.map((entry) => (entry.id === activeId ? { ...entry, content: entry.content + chunk } : entry))
        );
      } else {
        const id = `assistant-${Date.now()}`;
        streamMessageRef.current = id;
        setMessages((prev) => [
          ...prev,
          { id, role: "assistant", content: chunk, createdAt: new Date().toISOString(), pending: true },
        ]);
      }
      return "assistant";
    }
    if (frame.event === "error") {
      const message = readString(frame.data.message, "The agent stopped with an error");
      setAgentError(message);
      void optionsRef.current.onNotice?.(message, "error");
      return "ignored";
    }
    if (frame.event === "done") {
      const nextConversation = readString(frame.data.conversationId);
      if (nextConversation) setConversationId(nextConversation);
      const outcome = readString(frame.data.outcome);
      if (outcome === "completed" || outcome === "failed" || outcome === "paused" || outcome === "budget_exhausted" || outcome === "cancelled") {
        setRun((prev) => (prev ? { ...prev, outcome } : prev));
      }
      return "done";
    }
    // `tool_call` / `tool_result` are legacy compatibility frames: `activity`
    // already carries the same facts in human terms, so they are ignored.
    return "ignored";
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || abortRef.current) return;
      const createdAt = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content: trimmed, createdAt, pending: false },
      ]);
      setAgentError(null);
      setRestore(null);
      setStreaming(true);
      setEvents([]);
      streamMessageRef.current = null;
      lastUserPromptRef.current = trimmed;

      const controller = new AbortController();
      abortRef.current = controller;
      let assistantTextSeen = false;

      try {
        const res = await fetchApi(`/api/projects/${projectId}/agent`, {
          method: "POST",
          body: JSON.stringify({ message: trimmed, conversationId: conversationId ?? undefined }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(await errorFromResponse(res, "The agent could not be started"));
        }
        if (!res.body) throw new Error("The agent returned no stream.");

        for await (const frame of parseSseStream(res.body)) {
          const result = applyFrame(frame);
          if (result === "assistant") assistantTextSeen = true;
          if (result === "done") break;
        }
      } catch (err) {
        if (!isAbortError(err)) {
          const message = err instanceof Error ? err.message : "The agent request failed";
          setAgentError(message);
          void optionsRef.current.onNotice?.(message, "error");
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        setMessages((prev) => prev.map((entry) => (entry.pending ? { ...entry, pending: false } : entry)));
        streamMessageRef.current = null;
        // The authoritative record (counts, outcome, budget) only exists once
        // the run has written it, so this is when `/status` is re-read.
        void (async () => {
          await Promise.all([loadStatus(), loadCheckpoints()]);
          if (!assistantTextSeen) await loadTranscript();
          await optionsRef.current.onWorkspaceChanged?.();
        })();
      }
    },
    [projectId, conversationId, applyFrame, loadStatus, loadCheckpoints, loadTranscript]
  );

  // Read into locals so the memo dependencies match what the callback infers.
  const activeRunId = run?.id ?? null;

  const stop = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await requestJson<{ success: boolean }>(`/api/projects/${projectId}/agent/stop`, {
        method: "POST",
        body: JSON.stringify({ runId: activeRunId }),
      });
      void optionsRef.current.onNotice?.("Stop requested. The agent finishes the current step.", "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : "The run could not be stopped";
      setAgentError(message);
    }
  }, [projectId, activeRunId]);

  const continueRun = useCallback(async () => {
    await send(CONTINUE_PROMPT);
  }, [send]);

  const retryDifferently = useCallback(async () => {
    const prompt = lastUserPromptRef.current?.trim();
    await send(prompt ? `${prompt}\n\n${RETRY_PROMPT}` : RETRY_PROMPT);
  }, [send]);

  /* ---- Undo / redo ------------------------------------------------------- */

  const restoreStep = useCallback(
    async (direction: "undo" | "redo") => {
      setRestoreBusy(direction);
      setAgentError(null);
      try {
        const res = await fetchApi(`/api/workspace/${projectId}/${direction}`, { method: "POST" });
        const body = await res.json().catch(() => null);
        const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
        if (!res.ok) {
          // A 409 is a real refusal with a reason: show it as a blocked step.
          setRestore({
            checkpointId: "",
            label: direction === "undo" ? "Undo" : "Redo",
            status: "blocked",
            message: readString(record?.error) || `${direction === "undo" ? "Undo" : "Redo"} failed`,
            results: [],
          });
          return;
        }
        const report = parseRestoreReport(body);
        if (report) setRestore(report);
        void optionsRef.current.onNotice?.(
          report?.message ?? (direction === "undo" ? "Checkpoint reverted" : "Checkpoint re-applied"),
          report && report.status !== "partial" ? "success" : "error"
        );
        await Promise.all([loadCheckpoints(), loadStatus()]);
        await optionsRef.current.onWorkspaceChanged?.();
      } catch (err) {
        setAgentError(err instanceof Error ? err.message : "The restore could not be completed");
      } finally {
        setRestoreBusy(null);
      }
    },
    [projectId, loadCheckpoints, loadStatus]
  );

  const undo = useCallback(() => restoreStep("undo"), [restoreStep]);
  const redo = useCallback(() => restoreStep("redo"), [restoreStep]);

  const refresh = useCallback(async () => {
    await Promise.all([loadStatus(), loadCheckpoints(), loadTranscript()]);
  }, [loadStatus, loadCheckpoints, loadTranscript]);

  /* ---- Effects ----------------------------------------------------------- */

  useEffect(() => {
    if (!enabled || !projectId) return;
    void (async () => {
      await Promise.all([
        loadStatus().catch(() => undefined),
        loadCheckpoints().catch(() => undefined),
        loadTranscript().catch(() => undefined),
      ]);
    })();
  }, [enabled, projectId, loadStatus, loadCheckpoints, loadTranscript]);

  // A live elapsed clock needs one thing the server already gave us — the run's
  // start timestamp — and a tick. Nothing is interpolated before that exists.
  const live = isLiveRun(run, streaming);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  // Abandon the in-flight stream if the route unmounts mid-run.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const facts = useMemo(() => deriveRunFacts(events), [events]);
  const changedPathsByCheckpoint = useMemo(() => checkpointPathMap(events), [events]);
  const elapsed = useMemo(() => elapsedLabelOf(run, live, now), [run, live, now]);

  return {
    run,
    events,
    facts,
    changedPathsByCheckpoint,
    limits,
    flags,
    checkpoints,
    checkpointFiles,
    checkpointDetailBusy,
    checkpointDetailError,
    loadCheckpointDetail,
    restore,
    messages,
    conversationId,
    modelId,
    streaming,
    live,
    statusLoading,
    checkpointsLoading,
    restoreBusy,
    agentError,
    statusError,
    checkpointsError,
    elapsed,
    send,
    stop,
    continueRun,
    retryDifferently,
    undo,
    redo,
    refresh,
    // One dismiss gesture: the status read that produced `statusError` is
    // repeated by `refresh`, so hiding it is honest.
    dismissError: () => {
      setAgentError(null);
      setStatusError(null);
    },
    clearRestore: () => setRestore(null),
  };
}
