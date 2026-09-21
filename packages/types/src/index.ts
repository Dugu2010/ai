/**
 * @dai/types — shared, runtime-free TypeScript types for the DAI browser coding agent.
 * Imported by every package and the web app. Contains NO runtime dependencies.
 */

export type UUID = string;

/* ---------------- Auth ---------------- */
export interface User {
  id: UUID;
  email: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionUser {
  id: UUID;
  email: string;
  name: string | null;
}

/* ---------------- Projects ---------------- */
export type ProjectStatus = "provisioning" | "ready" | "paused" | "error" | "archived";

export interface Project {
  id: UUID;
  slug: string;
  name: string;
  description: string | null;
  userId: UUID;
  /**
   * Live Modal Sandbox id backing this project, once provisioned. The field is
   * named `sandboxId` because it is part of the public API contract; Postgres
   * remains the authoritative project-to-runtime mapping.
   */
  sandboxId: string | null;
  /** Which runtime owns this project's workspace: "modal" once provisioned. */
  runtimeProvider: string | null;
  /** Per-project subPath of the shared workspace Volume, mounted at /workspace. */
  runtimeVolumeSubPath: string | null;
  /**
   * Pre-Modal provider identifier, retained for traceability after the runtime
   * migration. Never used to address a live runtime.
   */
  legacySandboxId: string | null;
  /** Outcome of the CodeSandbox -> Modal workspace migration, if it ran. */
  runtimeMigrationStatus: string | null;
  /** Measured durable bytes for this project's workspace, or null if unknown. */
  workspaceBytes: number | null;
  /** When workspaceBytes was last measured by a real du against the Volume. */
  workspaceMeasuredAt: string | null;
  /** Deprecated CodeSandbox addressing slug. Read-only legacy data. */
  sandboxSlug: string | null;
  /** Deprecated Freestyle VM id. Read-only legacy data. */
  vmId: string | null;
  /** Deprecated Freestyle VM slug. Read-only legacy data. */
  vmSlug: string | null;
  status: ProjectStatus;
  /** Deprecated provider preview hostname. Modal previews are tunnel URLs. */
  previewDomain: string | null;
  previewPort: number | null;
  /** Public HTTPS URL of the live preview, if routed. */
  previewUrl: string | null;
  devServerRunning: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the runtime was last used, for cold-storage style warnings (>7 days). */
  lastAccessedAt: string | null;
  /** True when no live Sandbox is attached; the Volume itself always persists. */
  isHibernated: boolean;
  /** Provider-neutral boot classification kept for the UI: "CLEAN" new, "RESUME" reattached. */
  bootupType: "CLEAN" | "RESUME" | "RUNNING" | "FORK" | null;
  /** Reserved for a future runtime-update prompt; the image runtime is always current. */
  isUpToDate: boolean | null;
}

/* ---------------- Filesystem ---------------- */
export type FileKind = "file" | "directory" | "symlink";

export interface FileNode {
  name: string;
  /** Path relative to the project workspace root. */
  path: string;
  kind: FileKind;
  size: number;
  isDirectory: boolean;
  isSymlink: boolean;
  modified?: string;
  permissions?: string;
  owner?: string;
}

export interface ReadFileOptions {
  offset?: number;
  length?: number;
}

/* ---------------- Commands / Execution ---------------- */
export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

/* ---------------- Git ---------------- */
export interface GitStatus {
  branch: string | null;
  staged: string[];
  modified: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  clean: boolean;
  raw: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/* ---------------- Chat / Agent ---------------- */
export type MessageRole = string;

export interface AssistantToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutionResult {
  toolCallId: string;
  content: string;
  success: boolean;
}

export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  id: UUID;
  conversationId: UUID;
  role: MessageRole;
  content: string | null;
  projectId?: UUID;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: { success: boolean; result: string };
  toolCalls?: AssistantToolCall[];
  toolResults?: ToolExecutionResult[];
  name?: string | null;
  usage?: MessageUsage | null;
  createdAt: string;
}

export interface Conversation {
  id: UUID;
  projectId: UUID;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * SSE frames streamed from the agent endpoint to the browser.
 *
 * Names here match what the server actually writes. The previous version of this
 * union declared `arguments` where the stream sends `args`, and put the frame
 * kind in the JSON body when it is carried by the SSE `event:` line.
 */
export type AgentEvent =
  | { type: "activity"; event: ActivityEvent }
  | { type: "content"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; status: "success" | "error"; preview: string }
  | { type: "usage"; usage: MessageUsage }
  | { type: "error"; message: string }
  | { type: "done"; runId: string; outcome: AgentOutcome; stopReason: string | null };

export interface AgentConfig {
  maxIterations: number;
  contextWindowTokens: number;
  maxToolResultLength: number;
  maxCommandOutputLength: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolResult {
  callId: string;
  result: string;
  success: boolean;
  durationMs: number;
}

/* ---------------- NIM ---------------- */
export interface NimConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface AgentToolParam {
  name: string;
  description: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface NimChatResponse {
  content: string | null;
  toolCalls: AssistantToolCall[];
  usage: MessageUsage | null;
  finishReason: string | null;
}

/* ---------------- VM / Preview / Settings ---------------- */
export interface VMInfo {
  vmId: string;
  slug: string | null;
  state: string;
  idleTimeoutSeconds: number | null;
  snapshotId: string | null;
  resources: { cpu: number; memory: number; storage: number };
  publicIpv6: string | null;
  lastNetworkActivity: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewInfo {
  url: string;
  domain: string;
  port: number;
  ruleId: string | null;
}

export interface AppSettings {
  idleTimeoutSeconds: number;
  previewDomainSuffix: string;
  workspaceRoot: string;
  defaultModel: string;
  defaultBaseURL: string;
}

export interface UserSettings {
  id: string;
  userId: string;
  nimModel: string;
  nimBaseURL: string;
  nimApiKeyEnc: string | null;
  idleTimeoutSeconds: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export type Nullable<T> = T | null;

/** Small Result type used by helpers that can fail. */
export interface Ok<T> {
  ok: true;
  value: T;
}
export interface Err {
  ok: false;
  error: string;
  code?: string;
}
export type Result<T> = Ok<T> | Err;

/* ---------------- Agent runtime: states, activity, checkpoints ----------------
 * Canonical definitions shared by the API and the browser, so a status string
 * can never mean two different things on either side.
 */

/**
 * Position of the agent state machine. Every value is entered from a real
 * observed transition in the loop, never from a timer or an animation.
 */
export type AgentState =
  | "queued"
  | "thinking"
  | "inspecting"
  | "searching"
  | "reading"
  | "planning"
  | "editing"
  | "executing"
  | "testing"
  | "building"
  | "diagnosing"
  | "fixing"
  | "verifying"
  | "previewing"
  | "completed"
  | "failed"
  | "waiting"
  | "paused";

/** How a run ended. `paused` always arrives with a user-facing stopReason. */
export type AgentOutcome = "completed" | "failed" | "paused" | "budget_exhausted" | "cancelled";

/** The activity timeline vocabulary; the names are the wire contract. */
export type ActivityEventType =
  | "agent.started"
  | "agent.status"
  | "agent.file.read"
  | "agent.file.changed"
  | "agent.search"
  | "agent.runtime.requested"
  | "agent.runtime.started"
  | "agent.command.started"
  | "agent.command.completed"
  | "agent.test.started"
  | "agent.test.completed"
  | "agent.preview.started"
  | "agent.preview.ready"
  | "agent.error"
  | "agent.completed"
  | "agent.loop.detected"
  | "agent.undo.created"
  | "agent.undo.restored"
  | "agent.budget.exhausted";

/**
 * Facts attached to one event. Common keys are declared for type-safety at the
 * call sites; the index signature admits event-specific facts (offered choices,
 * an iteration counter) without every new event widening this interface.
 */
export interface ActivityEventDetail {
  path?: string;
  paths?: string[];
  command?: string;
  pattern?: string;
  matches?: number;
  filesRead?: number;
  changed?: number;
  exitCode?: number | null;
  failed?: number;
  durationMs?: number;
  timedOut?: boolean;
  sandboxId?: string;
  reused?: boolean;
  iterations?: number;
  runtimeMs?: number;
  checkpointId?: string;
  port?: number;
  url?: string;
  reason?: string;
  kind?: string;
  choices?: string[];
  [key: string]: unknown;
}

export interface ActivityEvent {
  id: number;
  runId: string;
  seq: number;
  type: ActivityEventType;
  state: AgentState | null;
  /** One short, high-level sentence. Never model reasoning, never raw JSON. */
  title: string;
  detail: ActivityEventDetail;
  createdAt: string;
}

export interface AgentRunCounts {
  iterations: number;
  toolCalls: number;
  execCalls: number;
  runtimeActivations: number;
  runtimeMs: number;
  filesChanged: number;
}

export interface AgentRun {
  id: string;
  projectId: string;
  conversationId: string | null;
  prompt: string;
  state: AgentState;
  outcome: AgentOutcome | null;
  stopReason: string | null;
  counts: AgentRunCounts;
  sandboxId: string | null;
  summary: string | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Everything the workspace needs to render status and its controls. */
export interface RunStatus {
  run: AgentRun | null;
  events: ActivityEvent[];
  limits: {
    maxActivationsPerRun: number;
    maxExecCallsPerRun: number;
    maxRuntimeSecondsPerRun: number;
    maxAgentIterations: number;
  };
  canUndo: boolean;
  canRedo: boolean;
  canContinue: boolean;
  canRetryDifferently: boolean;
}

export type FileChangeKind = "create" | "modify" | "delete" | "rename";

export interface CheckpointFile {
  path: string;
  changeKind: FileChangeKind;
  existedBefore: boolean;
  sizeBefore: number;
  sizeAfter: number;
  /** False when the file was too large to record, so it cannot be restored. */
  reversible: boolean;
  skipReason: string | null;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  runId: string | null;
  label: string;
  status: "applied" | "undone" | "partial";
  reversible: boolean;
  note: string | null;
  createdAt: string;
  undoneAt: string | null;
  files: CheckpointFile[];
}
