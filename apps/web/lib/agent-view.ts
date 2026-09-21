/**
 * The interpretation layer between the activity stream and the UI.
 *
 * Rules that keep the timeline honest:
 *  - Titles come from the backend. This module never writes progress copy.
 *  - Only facts present on an event are rendered; an absent field renders nothing.
 *  - Tones are derived from `type`/`state`, so a completed run cannot look like a
 *    failed one no matter how the stream is reordered.
 */

import type {
  ActivityEvent,
  ActivityEventDetail,
  ActivityEventType,
  AgentRun,
  AgentState,
  Checkpoint,
  RunStatus,
} from "@dai/types";
import { basename, formatDuration, formatElapsed, oneLine } from "./format";
import { readNumber, readString, readStringArray } from "./sse";

export type Tone = "neutral" | "accent" | "running" | "success" | "warning" | "danger";

export type ActivityIcon =
  | "queue"
  | "brain"
  | "folder"
  | "search"
  | "file-text"
  | "pencil"
  | "terminal"
  | "check-circle"
  | "x-circle"
  | "flask"
  | "hammer"
  | "stethoscope"
  | "wrench"
  | "shield-check"
  | "eye"
  | "play"
  | "refresh"
  | "undo"
  | "alert"
  | "gauge"
  | "sparkles";

export interface StateMeta {
  label: string;
  tone: Tone;
  /** True while the agent is still doing work on this state. */
  live: boolean;
}

const STATE_META: Record<AgentState, StateMeta> = {
  queued: { label: "Queued", tone: "neutral", live: true },
  thinking: { label: "Thinking", tone: "running", live: true },
  inspecting: { label: "Inspecting", tone: "running", live: true },
  searching: { label: "Searching", tone: "running", live: true },
  reading: { label: "Reading files", tone: "running", live: true },
  planning: { label: "Planning", tone: "running", live: true },
  editing: { label: "Editing files", tone: "accent", live: true },
  executing: { label: "Running a command", tone: "accent", live: true },
  testing: { label: "Running tests", tone: "accent", live: true },
  building: { label: "Building", tone: "accent", live: true },
  diagnosing: { label: "Diagnosing", tone: "warning", live: true },
  fixing: { label: "Fixing", tone: "accent", live: true },
  verifying: { label: "Verifying", tone: "accent", live: true },
  previewing: { label: "Previewing", tone: "accent", live: true },
  completed: { label: "Completed", tone: "success", live: false },
  failed: { label: "Failed", tone: "danger", live: false },
  waiting: { label: "Waiting", tone: "warning", live: true },
  paused: { label: "Paused", tone: "warning", live: false },
};

export const TERMINAL_OUTCOMES = new Set(["completed", "failed", "paused", "budget_exhausted", "cancelled"]);

export interface EventMeta {
  tone: Tone;
  icon: ActivityIcon;
}

const EVENT_META: Record<ActivityEventType, EventMeta> = {
  "agent.started": { tone: "accent", icon: "sparkles" },
  "agent.status": { tone: "neutral", icon: "brain" },
  "agent.file.read": { tone: "neutral", icon: "file-text" },
  "agent.file.changed": { tone: "accent", icon: "pencil" },
  "agent.search": { tone: "neutral", icon: "search" },
  "agent.runtime.requested": { tone: "warning", icon: "play" },
  "agent.runtime.started": { tone: "success", icon: "play" },
  "agent.command.started": { tone: "neutral", icon: "terminal" },
  "agent.command.completed": { tone: "success", icon: "check-circle" },
  "agent.test.started": { tone: "neutral", icon: "flask" },
  "agent.test.completed": { tone: "success", icon: "flask" },
  "agent.preview.started": { tone: "neutral", icon: "eye" },
  "agent.preview.ready": { tone: "success", icon: "eye" },
  "agent.error": { tone: "danger", icon: "x-circle" },
  "agent.completed": { tone: "success", icon: "check-circle" },
  "agent.loop.detected": { tone: "warning", icon: "refresh" },
  "agent.undo.created": { tone: "neutral", icon: "undo" },
  "agent.undo.restored": { tone: "warning", icon: "undo" },
  "agent.budget.exhausted": { tone: "danger", icon: "gauge" },
};

export function stateMeta(state: AgentState | null | undefined): StateMeta {
  if (!state) return { label: "Idle", tone: "neutral", live: false };
  return STATE_META[state] ?? { label: state, tone: "neutral", live: false };
}

/**
 * Validate one `activity` frame. The stream is the only source of timeline
 * rows, so a frame missing its sequence number or type is dropped instead of
 * being guessed at.
 */
export function parseActivityEvent(raw: unknown): ActivityEvent | null {
  // Frames arrive from the network, so a `null` or scalar body has to be
  // rejected here rather than thrown into the stream reader.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const frame = raw as Record<string, unknown>;
  const seq = readNumber(frame.seq);
  const type = readString(frame.type);
  if (seq === null || !type.startsWith("agent.")) return null;
  const createdAt = readString(frame.createdAt);
  const state = readString(frame.state);
  const detail = frame.detail;
  return {
    id: readNumber(frame.id) ?? 0,
    runId: readString(frame.runId),
    seq,
    type: type as ActivityEventType,
    state: state === "" ? null : (state as AgentState),
    title: readString(frame.title),
    detail: (detail && typeof detail === "object" && !Array.isArray(detail)
      ? detail
      : {}) as ActivityEventDetail,
    createdAt: createdAt || new Date(0).toISOString(),
  };
}


export function eventMeta(type: ActivityEventType): EventMeta {
  return EVENT_META[type] ?? { tone: "neutral", icon: "brain" };
}

/** CSS custom property for a tone — one mapping, used by every surface. */
export function toneVar(tone: Tone): string {
  switch (tone) {
    case "accent":
      return "var(--accent)";
    case "running":
      return "var(--accent)";
    case "success":
      return "var(--success)";
    case "warning":
      return "var(--warning)";
    case "danger":
      return "var(--danger)";
    default:
      return "var(--text-muted)";
  }
}

/* ---- Derived facts -------------------------------------------------------- */

export interface RunFacts {
  filesChanged: string[];
  filesRead: number;
  commands: number;
  tests: number;
  failures: number;
  errors: number;
  previewUrl: string | null;
  lastAction: string | null;
  /** Present when the run paused on a loop, carrying the offered choices. */
  pauseChoices: string[];
  pauseReason: string | null;
}

function detailPaths(detail: ActivityEventDetail): string[] {
  const direct = readStringArray(detail.paths);
  if (direct.length > 0) return direct;
  const single = readString(detail.path);
  return single ? [single] : [];
}

/**
 * Summarise the stream for the "current action" header. Every number here is a
 * count of real events, not an estimate.
 */
export function deriveRunFacts(events: readonly ActivityEvent[]): RunFacts {
  const changed = new Set<string>();
  let filesRead = 0;
  let commands = 0;
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let previewUrl: string | null = null;
  let pauseChoices: string[] = [];
  let pauseReason: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "agent.file.changed":
        for (const path of detailPaths(event.detail)) changed.add(path);
        break;
      case "agent.file.read":
        filesRead += detailPaths(event.detail).length || readNumber(event.detail.filesRead) || 0;
        break;
      case "agent.command.started":
        commands += 1;
        break;
      case "agent.test.started":
        tests += 1;
        break;
      case "agent.command.completed":
      case "agent.test.completed": {
        const failed = readNumber(event.detail.failed);
        if (failed && failed > 0) failures += failed;
        break;
      }
      case "agent.error":
        errors += 1;
        break;
      case "agent.preview.ready": {
        const url = readString(event.detail.url);
        if (url) previewUrl = url;
        break;
      }
      case "agent.loop.detected":
        pauseReason = event.title;
        break;
      case "agent.status": {
        const choices = readStringArray(event.detail.choices);
        if (choices.length > 0) {
          pauseChoices = choices;
          pauseReason = readString(event.detail.reason) || event.title;
        }
        break;
      }
      case "agent.undo.restored":
        for (const path of detailPaths(event.detail)) changed.delete(path);
        break;
      default:
        break;
    }
  }

  const last = events[events.length - 1];
  return {
    filesChanged: [...changed],
    filesRead,
    commands,
    tests,
    failures,
    errors,
    previewUrl,
    lastAction: last ? oneLine(last.title) : null,
    pauseChoices,
    pauseReason,
  };
}

/** A short, secondary line of facts for one event. Returns null when there are none. */
export function eventFacts(event: ActivityEvent): string | null {
  const detail = event.detail;
  const parts: string[] = [];
  const paths = detailPaths(detail);
  const pattern = readString(detail.pattern);
  const command = readString(detail.command);
  const durationMs = readNumber(detail.durationMs);
  const exitCode = readNumber(detail.exitCode);
  const failed = readNumber(detail.failed);
  const matches = readNumber(detail.matches);
  const filesRead = readNumber(detail.filesRead);
  const changed = readNumber(detail.changed);
  const url = readString(detail.url);

  if (pattern) parts.push(`"${pattern}"`);
  if (matches !== null) parts.push(`${matches} match${matches === 1 ? "" : "es"}`);
  if (command) parts.push(oneLine(command, 70));
  if (filesRead !== null) parts.push(`${filesRead} file${filesRead === 1 ? "" : "s"}`);
  if (changed !== null) parts.push(`${changed} changed`);
  if (failed !== null && failed > 0) parts.push(`${failed} failed`);
  if (exitCode !== null && exitCode !== 0) parts.push(`exit ${exitCode}`);
  if (detail.timedOut === true) parts.push("timed out");
  if (durationMs !== null) parts.push(formatDuration(durationMs));
  if (url) parts.push(url.replace(/^https?:\/\//, "").slice(0, 40));
  if (paths.length > 0) {
    parts.push(paths.length === 1 ? basename(paths[0] ?? "") : `${paths.length} files`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Full path list for an event, for the expandable detail row. */
export function eventPaths(event: ActivityEvent): string[] {
  return detailPaths(event.detail);
}

/* ---- Budget --------------------------------------------------------------- */

export interface BudgetRow {
  key: string;
  label: string;
  used: number;
  limit: number;
  unit: string;
}

/**
 * Used vs allowed for the current run. The `used` figures come from the run
 * record's counts, so a refresh cannot lose them and they never interpolate.
 */
export function budgetRows(run: AgentRun | null, limits: RunStatus["limits"] | null): BudgetRow[] {
  if (!limits) return [];
  const counts = run?.counts;
  const seconds = counts ? Math.round((counts.runtimeMs ?? 0) / 1000) : 0;
  return [
    { key: "activations", label: "Activations", used: counts?.runtimeActivations ?? 0, limit: limits.maxActivationsPerRun, unit: "" },
    { key: "commands", label: "Commands", used: counts?.execCalls ?? 0, limit: limits.maxExecCallsPerRun, unit: "" },
    { key: "runtime", label: "Runtime", used: seconds, limit: limits.maxRuntimeSecondsPerRun, unit: "s" },
    { key: "iterations", label: "Iterations", used: counts?.iterations ?? 0, limit: limits.maxAgentIterations, unit: "" },
  ];
}

export function budgetTone(used: number, limit: number): Tone {
  if (limit <= 0) return "neutral";
  if (used >= limit) return "danger";
  if (used >= limit * 0.75) return "warning";
  return "neutral";
}

/**
 * Why a run stopped, in the user's terms. Cost exhaustion is reported as cost,
 * not as failure — the distinction is the whole point of the budget panel.
 */
export function outcomeCopy(run: AgentRun | null): { label: string; tone: Tone; reason: string | null } | null {
  if (!run) return null;
  const reason = run.stopReason ?? run.lastError ?? null;
  switch (run.outcome) {
    case "completed":
      return { label: "Completed", tone: "success", reason: null };
    case "failed":
      return { label: "Failed", tone: "danger", reason };
    case "budget_exhausted":
      return { label: "Stopped on budget", tone: "warning", reason };
    case "cancelled":
      return { label: "Stopped", tone: "neutral", reason };
    case "paused":
      return { label: "Paused", tone: "warning", reason };
    default:
      return { label: stateMeta(run.state).label, tone: stateMeta(run.state).tone, reason };
  }
}

export function isLiveRun(run: AgentRun | null, streaming: boolean): boolean {
  if (streaming) return true;
  if (!run) return false;
  if (run.outcome && TERMINAL_OUTCOMES.has(run.outcome)) return false;
  return stateMeta(run.state).live;
}

/**
 * Elapsed wall time for a run, measured between two server-provided
 * timestamps. A live run extends to the local tick; a finished one uses its
 * own `finishedAt`, so a refresh cannot invent extra duration.
 */
export function elapsedLabelOf(run: AgentRun | null, live: boolean, now: number): string {
  if (!run?.createdAt) return "";
  // A run that ended without a recorded finish time has no honest duration, so
  // none is shown.
  if (!live && !run.finishedAt) return "";
  return formatElapsed(run.createdAt, live ? null : run.finishedAt, live ? now : undefined);
}


/**
 * Link checkpoints to the paths their run changed, using only the stream:
 * `agent.undo.created` carries the checkpoint id, and the file-change events
 * before it belong to that checkpoint.
 */
export function checkpointPathMap(
  events: readonly ActivityEvent[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let pending = new Set<string>();
  for (const event of events) {
    if (event.type === "agent.file.changed") {
      for (const path of detailPaths(event.detail)) pending.add(path);
      continue;
    }
    if (event.type === "agent.undo.created") {
      const id = readString(event.detail.checkpointId);
      if (id && pending.size > 0) map.set(id, [...pending]);
      pending = new Set<string>();
    }
  }
  return map;
}

export type CheckpointSummary = Omit<Checkpoint, "files"> & { fileCount: number };

/**
 * One stored pre/post image, as returned by the checkpoint detail endpoint.
 * This is the only source the diff viewer may render from: the numbers and the
 * +/- text come from bytes the server recorded, never from the model's account
 * of what it changed.
 */
export interface CheckpointFile {
  path: string;
  changeKind: "create" | "modify" | "delete" | "rename";
  contentBefore: string | null;
  contentAfter: string | null;
  existedBefore: boolean;
  sizeBefore: number;
  sizeAfter: number;
  reversible: boolean;
  skipReason: string | null;
}

export function parseCheckpointFiles(raw: unknown): CheckpointFile[] {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const checkpoint = record?.checkpoint;
  const files = checkpoint && typeof checkpoint === "object"
    ? (checkpoint as Record<string, unknown>).files
    : undefined;
  if (!Array.isArray(files)) return [];
  return files.filter((file): file is CheckpointFile => {
    if (!file || typeof file !== "object") return false;
    const row = file as Record<string, unknown>;
    return typeof row.path === "string" && typeof row.changeKind === "string";
  });
}

export interface RestoreResultRow {
  path: string;
  status: string;
  detail: string;
}

export interface RestoreReport {
  checkpointId: string;
  label: string;
  status: "undone" | "redone" | "partial" | "blocked";
  message: string | null;
  results: RestoreResultRow[];
}

/** Narrow a `/undo` `/redo` body into a renderable report without `any`. */
export function parseRestoreReport(raw: unknown): RestoreReport | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const status = readString(record.status);
  if (status !== "undone" && status !== "redone" && status !== "partial" && status !== "blocked") return null;
  const rows = Array.isArray(record.results) ? record.results : [];
  return {
    checkpointId: readString(record.checkpointId),
    label: readString(record.label),
    status,
    message: typeof record.message === "string" ? record.message : null,
    results: rows.map((row) => {
      const entry = readRecordValue(row);
      return {
        path: readString(entry.path),
        status: readString(entry.status, "unknown"),
        detail: readString(entry.detail),
      };
    }),
  };
}

function readRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function restoreTone(status: RestoreReport["status"]): Tone {
  if (status === "partial" || status === "blocked") return "warning";
  if (status === "undone") return "warning";
  return "success";
}
