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
  /** Freestyle VM id backing this project, once provisioned. */
  vmId: string | null;
  /** Freestyle slug used to address the VM (e.g. `dai-<slug>`). */
  vmSlug: string | null;
  status: ProjectStatus;
  /** The `<slug>.style.dev` domain routed to the dev server. */
  previewDomain: string | null;
  previewPort: number | null;
  /** Public HTTPS URL of the live preview, if routed. */
  previewUrl: string | null;
  devServerRunning: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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

/* SSE events streamed from the server to the browser chat UI. */
export type AgentEvent =
  | { type: "activity"; message: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; result: string; success: boolean; durationMs: number }
  | { type: "usage"; usage: MessageUsage }
  | { type: "error"; error: string }
  | { type: "done" };

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

export interface AgentState {
  runId: string;
  status: "running" | "paused" | "completed" | "error" | "canceled";
  iteration: number;
  maxIterations: number;
  currentTool: string | null;
  createdAt: string;
  updatedAt: string;
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