/**
 * The agent loop.
 *
 * inspect → understand → search/read → plan → edit → execute only when needed →
 * inspect output → test → diagnose → fix → verify → preview → complete.
 *
 * Three properties are enforced here rather than hoped for:
 *
 *  ONE runtime per run. A Sandbox is acquired once and reused for every tool
 *  call, so a run costs one activation instead of one per operation.
 *
 *  BATCHED file work. Reads within an iteration collapse into a single command,
 *  and all writes in an iteration are applied by one command, because on this
 *  provider each filesystem call is itself a Sandbox command.
 *
 *  A HARD BUDGET. Activations, commands, wall-clock runtime, iterations and tool
 *  calls are all counted; on exhaustion the run degrades with a stated reason
 *  instead of continuing to spend.
 */

import {
  classifyCommand,
  errorSignature,
  parseFailureCount,
  type ActivityEventType,
  type AgentState,
} from "./activity.js";
import type { LoopDetector } from "./loop-detector.js";
import type { RuntimeBudget } from "./runtime-policy.js";
import { validateCommandOptions, validatePath } from "./validation.js";
import { WORKSPACE_ROOT } from "./validation.js";
import type { ToolDefinition } from "@dai/nim";
import type { ExecResult, Workspace } from "@dai/modal";

export const MAX_ITERATIONS_DEFAULT = 12;

export const TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_files",
  "search_content",
  "write_file",
  "edit_file",
  "delete_file",
  "rename_file",
  "run_command",
  "run_tests",
  "start_dev_server",
  "stop_dev_server",
  "get_project_status",
  "get_preview_url",
  "git_status",
  "git_diff",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const MUTATING: ReadonlySet<string> = new Set(["write_file", "edit_file", "delete_file", "rename_file"]);
const READERS: ReadonlySet<string> = new Set(["read_file"]);

/**
 * Tool definitions given to NIM. Names are unchanged from the previous runtime so
 * the agent's conceptual interface did not move with the provider.
 */
export const TOOLS: ToolDefinition[] = [
  fn("list_files", "List files and directories under a path in the project workspace", { path: str("Path to list (default /workspace)") }),
  fn("read_file", "Read a file's contents", { path: str("File path under /workspace") }, ["path"]),
  fn("search_files", "Find files by name pattern", { pattern: str("Glob pattern"), dir: str("Directory (default /workspace)") }, ["pattern"]),
  fn("search_content", "Search file contents for a string", { pattern: str("Text to find"), dir: str("Directory (default /workspace)") }, ["pattern"]),
  fn("write_file", "Create or overwrite a file with complete contents", { path: str("File path"), content: str("Full file content") }, ["path", "content"]),
  fn(
    "edit_file",
    "Replace an exact string inside a file. Prefer this over rewriting whole files.",
    {
      path: str("File path"),
      oldString: str("Exact text to replace; must appear once"),
      newString: str("Replacement text"),
    },
    ["path", "oldString", "newString"]
  ),
  fn("delete_file", "Delete a file", { path: str("File path") }, ["path"]),
  fn("rename_file", "Rename or move a file or directory", { oldPath: str("Current path"), newPath: str("New path") }, ["oldPath", "newPath"]),
  fn(
    "run_command",
    "Run a shell command in the project sandbox. Costs runtime: use it when you need to actually execute something.",
    { command: str("Command to run"), cwd: str("Working directory (default /workspace)"), timeoutMs: num("Timeout in ms") },
    ["command"]
  ),
  fn("run_tests", "Run the project's test suite and report failures", { filter: str("Optional test name filter") }),
  fn("start_dev_server", "Start (or reuse) the dev server and return a preview URL", { command: str("Start command"), port: num("Port") }),
  fn("stop_dev_server", "Stop the dev server", { port: num("Port") }),
  fn("get_project_status", "Report project runtime state, changed files and budget used"),
  fn("get_preview_url", "Get the authenticated preview URL for a running dev server", { port: num("Port") }),
  fn("git_status", "Show git branch, staged, modified and untracked files"),
  fn("git_diff", "Show staged and unstaged git changes"),
];

function str(description: string) {
  return { type: "string", description };
}
function num(description: string) {
  return { type: "number", description };
}
function fn(
  name: ToolName,
  description: string,
  properties: Record<string, unknown> = {},
  required?: string[]
): ToolDefinition {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, ...(required ? { required } : {}) } },
  };
}

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.function.name === name);
}

/**
 * Read-through cache for the run.
 *
 * Safe to cache because a run holds a Postgres advisory lock on its project, so
 * nothing else mutates the workspace concurrently, and the cache is dropped
 * whenever this run changes a file or executes a command that could have.
 */
export class RunFileCache {
  private values = new Map<string, string | null>();
  hits = 0;
  loads = 0;

  peek(path: string): { hit: boolean; content: string | null } {
    if (this.values.has(path)) {
      this.hits++;
      return { hit: true, content: this.values.get(path) ?? null };
    }
    return { hit: false, content: null };
  }

  store(path: string, content: string | null): void {
    this.loads++;
    this.values.set(path, content);
  }

  /** Anything a command may have touched makes every cached read suspect. */
  invalidateAll(): void {
    this.values.clear();
  }
}

export interface ToolOutcomeText {
  result: string;
  success: boolean;
  /** Files this call changed, for checkpointing and the activity timeline. */
  touched?: string[];
}

export interface RunDeps {
  workspace: Workspace;
  projectId: string;
  runId: string;
  budget: RuntimeBudget;
  loop: LoopDetector;
  cache: RunFileCache;
  emit: (
    type: ActivityEventType,
    title: string,
    detail?: Record<string, unknown>,
    state?: AgentState
  ) => void;
  /** Called before a mutating iteration so a checkpoint exists for it. */
  flushCheckpoint: (label: string) => Promise<void>;
  previewPort: number;
}

/** A tool call that changes files, already argument-checked. */
export interface PendingWrite {
  callId: string;
  path: string;
  content: string | null;
  kind: "create" | "modify" | "delete" | "rename";
  fromPath?: string;
}

/**
 * Execute one tool call that does NOT change files.
 *
 * Mutations are deliberately handled elsewhere, batched per iteration, so a
 * multi-file edit costs one command instead of one per file.
 */
export async function executeReadOnly(
  deps: Pick<RunDeps, "workspace" | "cache" | "budget" | "previewPort">,
  name: string,
  args: Record<string, unknown>
): Promise<ToolOutcomeText> {
  const { workspace, cache } = deps;
  switch (name) {
    case "list_files": {
      const path = String(args.path ?? WORKSPACE_ROOT);
      const v = validatePath(path);
      if (!v.valid || !v.normalized) return fail(v.error);
      const entries = await workspace.listFiles(v.normalized);
      return {
        result: JSON.stringify(entries, null, 2),
        success: true,
        touched: [],
      };
    }
    case "read_file": {
      const v = validatePath(String(args.path ?? ""));
      if (!v.valid || !v.normalized) return fail(v.error);
      const cached = cache.peek(v.normalized);
      if (cached.hit) {
        return cached.content === null
          ? { result: "Error: file not found", success: false }
          : { result: cached.content, success: true };
      }
      const content = await workspace.readFile(v.normalized);
      if (content === null) return { result: "Error: file not found", success: false };
      cache.store(v.normalized, content);
      return { result: content, success: true };
    }
    case "search_files": {
      const dir = validatePath(String(args.dir ?? WORKSPACE_ROOT));
      if (!dir.valid || !dir.normalized) return fail(dir.error);
      const files = await workspace.searchFiles(dir.normalized, String(args.pattern ?? "*"));
      return { result: files.length ? files.join("\n") : "No files matched", success: true };
    }
    case "search_content": {
      const dir = validatePath(String(args.dir ?? WORKSPACE_ROOT));
      if (!dir.valid || !dir.normalized) return fail(dir.error);
      const matches = await workspace.searchContent(dir.normalized, String(args.pattern ?? ""));
      return { result: matches.length ? JSON.stringify(matches, null, 2) : "No content matched", success: true };
    }
    case "run_command":
    case "run_tests": {
      const command =
        name === "run_tests"
          ? buildTestCommand(String(args.filter ?? ""))
          : String(args.command ?? "");
      const validation = validateCommandOptions({
        command,
        cwd: args.cwd ? String(args.cwd) : undefined,
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined,
      });
      if (!validation.valid) return fail(validation.error);
      const cwd = validatePath(String(args.cwd ?? WORKSPACE_ROOT));
      if (!cwd.valid || !cwd.normalized) return fail(cwd.error);

      const charged = deps.budget.startExec();
      if (!charged.ok) return { result: `Error: ${charged.message}`, success: false };
      const timeoutMs = deps.budget.commandTimeoutMs(args.timeoutMs ? Number(args.timeoutMs) : undefined);
      const executed: ExecResult = await workspace.exec(command, { cwd: cwd.normalized, timeoutMs });
      // Any command may have rewritten anything.
      deps.cache.invalidateAll();
      return formatExecuted(command, executed);
    }
    case "git_status": {
      const charged = deps.budget.startExec();
      if (!charged.ok) return { result: `Error: ${charged.message}`, success: false };
      const status = await workspace.getGitStatus(WORKSPACE_ROOT);
      return { result: JSON.stringify(status, null, 2), success: true };
    }
    case "git_diff": {
      const charged = deps.budget.startExec();
      if (!charged.ok) return { result: `Error: ${charged.message}`, success: false };
      const diff = await workspace.getGitDiff(WORKSPACE_ROOT);
      return { result: JSON.stringify(diff, null, 2).slice(0, 100_000), success: true };
    }
    case "start_dev_server": {
      const charged = deps.budget.startExec();
      if (!charged.ok) return { result: `Error: ${charged.message}`, success: false };
      const port = Number(args.port ?? deps.previewPort);
      const command = String(args.command ?? "npm run dev");
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return fail("a valid port is required");
      const server = await workspace.startDevServer({ command, port, cwd: WORKSPACE_ROOT });
      const preview = await workspace.getPreviewUrl(port);
      return {
        result: JSON.stringify({ reused: server.reused, ready: server.ready, url: preview.url, port }),
        success: true,
      };
    }
    case "stop_dev_server": {
      await workspace.stopDevServer(Number(args.port ?? deps.previewPort));
      return { result: "Dev server stopped", success: true };
    }
    case "get_preview_url": {
      const preview = await workspace.getPreviewUrl(Number(args.port ?? deps.previewPort));
      return preview.url
        ? { result: JSON.stringify({ url: preview.url }), success: true }
        : { result: "Error: no preview is available; start the dev server first", success: false };
    }
    case "get_project_status": {
      return {
        result: JSON.stringify(
          {
            sandboxId: workspace.sandboxId,
            runtime: describeBudget(deps.budget),
            iterationsRemaining: deps.budget.iterationsRemaining,
          },
          null,
          2
        ),
        success: true,
      };
    }
    default:
      return { result: `Error: unknown tool ${name}`, success: false };
  }
}

/** Human-readable spend summary, e.g. "2/40 commands, 31s/600s runtime". */
export function describeBudget(budget: RuntimeBudget): string {
  const spent = budget.summary();
  return `${spent.activations}/${spent.limits.maxActivationsPerRun} activations, ${spent.execCalls}/${spent.limits.maxExecCallsPerRun} commands, ${Math.round(spent.runtimeMs / 1000)}/${spent.limits.maxRuntimeSecondsPerRun}s runtime`;
}

export function budgetIterationsRemaining(budget: RuntimeBudget): number {
  return budget.iterationsRemaining;
}

function fail(error: string | undefined): ToolOutcomeText {
  return { result: `Error: ${error ?? "invalid request"}`, success: false };
}

function buildTestCommand(filter: string): string {
  const suffix = filter ? ` -- ${filter}` : "";
  return `npm test${suffix}`;
}

/** Render an ExecResult for the model, keeping exit code and stream labels. */
export function formatExecuted(command: string, executed: ExecResult): ToolOutcomeText {
  const sections = [
    executed.stdout ? `stdout:\n${executed.stdout}` : null,
    executed.stderr ? `stderr:\n${executed.stderr}` : null,
    executed.timedOut ? "timed out" : null,
    `exit code: ${executed.exitCode}`,
  ].filter(Boolean);
  return {
    result: sections.join("\n") || "(no output)",
    success: executed.exitCode === 0 && !executed.timedOut,
    touched: [],
  };
}

export interface ExecSummary {
  kind: ReturnType<typeof classifyCommand>["kind"];
  title: string;
  failures: number | null;
  signature: string;
}

/** Facts shown in the timeline, derived from the actual command and output. */
export function summarizeExecution(command: string, executed: ExecResult): ExecSummary {
  const classified = classifyCommand(command);
  const combined = `${executed.stdout ?? ""}\n${executed.stderr ?? ""}`;
  return {
    kind: classified.kind,
    title: classified.title,
    failures: parseFailureCount(combined),
    signature: errorSignature(combined, executed.exitCode),
  };
}

export function isMutatingTool(name: string): boolean {
  return MUTATING.has(name);
}

export function isReaderTool(name: string): boolean {
  return READERS.has(name);
}

/**
 * Resolve a mutating call into the exact file content it wants, without touching
 * the runtime: `edit_file` needs the current text, which comes from the cache or
 * is loaded by the caller's batched read.
 */
export function resolveDesiredContent(
  name: string,
  args: Record<string, unknown>,
  current: string | null
):
  | { ok: true; content: string | null; kind: PendingWrite["kind"]; fromPath?: string }
  | { ok: false; error: string } {
  const path = String(args.path ?? "");
  switch (name) {
    case "write_file":
      return { ok: true, content: String(args.content ?? ""), kind: current === null ? "create" : "modify" };
    case "edit_file": {
      const oldString = String(args.oldString ?? "");
      const newString = String(args.newString ?? "");
      if (!oldString) return { ok: false, error: "oldString is required" };
      if (current === null) return { ok: false, error: "file not found" };
      const first = current.indexOf(oldString);
      if (first === -1) return { ok: false, error: "oldString not found in file" };
      if (current.indexOf(oldString, first + 1) !== -1) {
        return { ok: false, error: "oldString matches multiple locations; include more surrounding text" };
      }
      return {
        ok: true,
        content: current.slice(0, first) + newString + current.slice(first + oldString.length),
        kind: "modify",
      };
    }
    case "delete_file":
      return { ok: true, content: null, kind: "delete" };
    case "rename_file": {
      const newPath = String(args.newPath ?? "");
      if (!newPath) return { ok: false, error: "newPath is required" };
      return { ok: true, content: current, kind: "rename", fromPath: path };
    }
    default:
      return { ok: false, error: `not a mutating tool: ${name}` };
  }
}


