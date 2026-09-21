/**
 * The agent loop.
 *
 * inspect → read/search → plan → edit → execute when needed → inspect output →
 * test → diagnose → fix → verify → preview → complete.
 *
 * Four invariants this file exists to enforce:
 *
 * 1. ONE RUNTIME ACTIVATION. The caller attaches the Sandbox before the loop
 *    starts and passes it in; nothing here acquires, resumes or provisions
 *    compute. Every command is charged to `budget` before it runs, and when the
 *    budget is spent the loop degrades with a stated reason.
 * 2. BATCHED MUTATIONS. All file changes a model turn asks for are applied in a
 *    single command, and the checkpoint holding their pre-images is written
 *    before any of them land, so undo always has the real "before".
 * 3. DEDUPLICATED READS. Content read once during a run is served from an
 *    in-run cache, because on this provider a second read is a second command.
 * 4. OBSERVABLE, NEVER INVENTED. Activity titles come from results that actually
 *    came back. No timer produces progress, and no model reasoning is forwarded.
 */

import type { ChatMessage, NIMClient, ToolCall } from "@dai/nim";
import type { FileMutation, Workspace } from "@dai/modal";
import type { AgentOutcome, AgentState } from "@dai/types";
import { CheckpointCollector } from "./checkpoint-service.js";
import type { Emitter } from "./activity.js";
import { classifyCommand, errorSignature, parseFailureCount } from "./activity.js";
import { validatePath } from "./validation.js";
import type { LoopDetector } from "./loop-detector.js";
import { callKey } from "./loop-detector.js";
import type { RuntimeBudget } from "./runtime-policy.js";
import {
  executeReadOnly,
  isMutatingTool,
  resolveDesiredContent,
  RunFileCache,
  TOOLS,
  type RunDeps,
  type ToolOutcomeText,
} from "./agent-run.js";

const MAX_TOOL_RESULT_CHARS = 8_000;

/** One intended write, plus the bytes it must find in order to be allowed. */
interface PlannedEdit {
  path: string;
  content: string | null;
  expectCurrent: string | null;
}

export interface AgentLoopInput {
  projectId: string;
  runId: string;
  prompt: string;
  workspace: Workspace;
  nim: NIMClient;
  /** System prompt + replayed history + this turn's user message. */
  messages: ChatMessage[];
  emit: Emitter;
  budget: RuntimeBudget;
  loop: LoopDetector;
  previewPort: number;
  recordToolCall: (entry: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    result: string;
    success: boolean;
  }) => Promise<void>;
  /** Checked between iterations so Stop ends the run cleanly, not mid-command. */
  aborted?: () => boolean;
  /**
   * Called with each piece of assistant prose as it arrives. Without this only
   * the last turn's text would reach the chat, so a model that narrates "I will
   * add a README" before editing would appear silent and then dump a summary.
   */
  onAssistantText?: (text: string) => void;
}

export interface AgentLoopResult {
  outcome: AgentOutcome;
  state: AgentState;
  stopReason: string | null;
  content: string | null;
  toolCalls: number;
  filesChanged: number;
  checkpointId: string | null;
  contentStreamed: boolean;
  iterations: number;
  execCalls: number;
  runtimeActivations: number;
  runtimeMs: number;
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { workspace, nim, messages, emit, budget, loop, projectId, runId } = input;

  const cache = new RunFileCache();
  const collector = new CheckpointCollector(budget.limits.maxCheckpointFileBytes);
  const deps: RunDeps = {
    workspace,
    projectId,
    runId,
    budget,
    loop,
    cache,
    emit,
    flushCheckpoint: async (label) => {
      await commitCheckpoint(label);
    },
    previewPort: input.previewPort,
  };

  let finalContent: string | null = null;
  let contentStreamed = false;
  let toolCalls = 0;
  let filesChanged = 0;
  let checkpointId: string | null = null;
  let stopReason: string | null = null;
  let outcome: AgentOutcome = "completed";

  /** Set when a checkpoint still has to be written for the current turn. */
  let pendingLabel: string | null = null;

  emit("agent.started", "Task accepted", { prompt: input.prompt.slice(0, 400) }, "queued");

  outer: while (true) {
    if (input.aborted?.()) {
      outcome = "cancelled";
      stopReason = "Stopped by you.";
      emit("agent.status", "Stopped", { reason: "user requested stop" }, "paused");
      break;
    }
    if (budget.iterationsRemaining <= 0) {
      outcome = "budget_exhausted";
      stopReason = `Reached the ${budget.limits.maxAgentIterations}-iteration limit for one run.`;
      emit("agent.budget.exhausted", stopReason, { limit: budget.limits.maxAgentIterations }, "waiting");
      break;
    }
    if (!budget.useIteration()) break;

    // "thinking" brackets a real await on the model, not a decorative pause.
    emit("agent.status", "Deciding what to do next", { iteration: budget.iterations }, "thinking");

    let response;
    try {
      response = await nim.chat({ messages, tools: TOOLS });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = "failed";
      stopReason = `The model request failed: ${message}`;
      emit("agent.error", "Could not reach the model", { reason: message }, "failed");
      break;
    }

    if (response.content) {
      finalContent = response.content;
      contentStreamed = true;
      input.onAssistantText?.(response.content);
    }
    if (response.toolCalls.length === 0) break;

    messages.push({
      role: "assistant",
      content: response.content ?? null,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    });

    const reads: string[] = [];
    const edits: PlannedEdit[] = [];
    const observations: Array<{ callKey: string; subject?: string; errorSignature?: string }> = [];

    for (const call of response.toolCalls) {
      toolCalls += 1;
      const args = call.arguments ?? {};
      let result: ToolOutcomeText;

      if (isMutatingTool(call.name)) {
        result = await planMutation(call, args);
      } else {
        result = await runNonMutating(call, args);
      }

      const payload = result.result.slice(0, MAX_TOOL_RESULT_CHARS);
      messages.push({ role: "tool", content: payload, tool_call_id: call.id, name: call.name });
      await input.recordToolCall({ callId: call.id, name: call.name, args, result: payload, success: result.success });

      observations.push({
        callKey: callKey(call.name, args),
        subject: mutationSubject(call.name, args),
        errorSignature: result.success ? undefined : errorSignature(result.result, null),
      });
    }

    // Apply everything this turn asked for as one command, after the checkpoint
    // that describes the pre-images has been stored.
    let changedThisTurn = 0;
    let changedBytes = 0;
    if (edits.length > 0) {
      const applied = await applyEdits(edits);
      changedThisTurn = applied.changed;
      changedBytes = applied.bytes;
      filesChanged += applied.changed;
      if (applied.changed > 0) {
        emit(
          "agent.file.changed",
          describeChanges(applied.paths.map((path) => ({ path }))),
          { paths: applied.paths, changed: applied.changed }
        );
      }
    }

    if (reads.length > 0) {
      emit(
        "agent.file.read",
        reads.length === 1 ? `Reading ${shortName(reads[0]!)}` : `Reading ${reads.length} relevant files`,
        { paths: reads, filesRead: reads.length }
      );
    }

    if (changedThisTurn > 0) loop.noteProgress();
    for (const observation of observations) {
      loop.record({ ...observation, filesChanged: changedThisTurn, changedBytes });
    }

    const verdict = loop.assess();
    if (verdict.looping) {
      emit("agent.loop.detected", verdict.summary, { kind: verdict.kind ?? undefined, recoveries: loop.recoveries }, "diagnosing");
      if (verdict.shouldPause) {
        outcome = "paused";
        stopReason = verdict.summary;
        emit(
          "agent.status",
          "The agent appears to be repeating the same approach",
          { choices: ["continue", "retry-differently", "undo"], reason: verdict.summary },
          "paused"
        );
        break outer;
      }
      // One bounded strategy change, authored by us. This is guidance we write,
      // not reasoning we recovered from the model.
      messages.push({
        role: "system",
        content: `The previous approach is repeating without progress: ${verdict.summary} ${
          verdict.suggestedStrategy ?? "Try a materially different approach and do not re-run the same step."
        }`,
      });
      emit("agent.status", "Switching to a different approach", { kind: verdict.kind ?? undefined }, "planning");
    }

    const exhausted = budget.summary().exhausted;
    if (exhausted) {
      outcome = "budget_exhausted";
      stopReason =
        exhausted === "exec_calls"
          ? `Stopped after ${budget.limits.maxExecCallsPerRun} runtime commands in this run.`
          : exhausted === "runtime_seconds"
            ? `Stopped after ${budget.limits.maxRuntimeSecondsPerRun}s of runtime in this run.`
            : `Stopped after ${budget.limits.maxAgentIterations} iterations in this run.`;
      emit("agent.budget.exhausted", stopReason, { reason: exhausted }, "waiting");
      break;
    }

    /**
     * ---- per-turn helpers -------------------------------------------------
     */
    async function runNonMutating(call: ToolCall, args: Record<string, unknown>): Promise<ToolOutcomeText> {
      const gate = budget.startExec();
      if (!gate.ok) {
        emit("agent.error", "Operation skipped: runtime budget exhausted", { reason: gate.message }, "waiting");
        return { result: `Error: ${gate.message}`, success: false };
      }

      if (call.name === "run_command" || call.name === "run_tests") {
        const command =
          call.name === "run_tests"
            ? buildTestCommand(String(args.filter ?? ""))
            : String(args.command ?? "");
        if (!command.trim()) return { result: "Error: command is required", success: false };
        return await runCommand(call.name, command, args);
      }

      if (call.name === "read_file") {
        const outcomeText = await executeReadOnly(deps, call.name, args);
        const path = String(args.path ?? "");
        if (outcomeText.success && path) reads.push(path);
        return outcomeText;
      }

      if (call.name === "list_files") {
        emit("agent.status", "Inspecting project structure", {}, "inspecting");
        const outcomeText = await executeReadOnly(deps, call.name, args);
        if (outcomeText.success) {
          emit("agent.status", "Inspected project structure", {
            filesRead: outcomeText.result.split("\n").filter(Boolean).length,
          });
        }
        return outcomeText;
      }

      if (call.name === "search_files" || call.name === "search_content") {
        const pattern = String(args.pattern ?? "").slice(0, 80);
        emit("agent.status", `Searching for "${pattern}"`, { pattern }, "searching");
        const outcomeText = await executeReadOnly(deps, call.name, args);
        const matched = outcomeText.success && !/^No (files|content) matched$/.test(outcomeText.result);
        emit(
          "agent.search",
          `Found ${matched ? outcomeText.result.split("\n").filter(Boolean).length : 0} match(es) for "${pattern}"`,
          { pattern, matches: matched ? outcomeText.result.split("\n").filter(Boolean).length : 0 }
        );
        return outcomeText;
      }

      if (call.name === "start_dev_server" || call.name === "get_preview_url") {
        emit("agent.preview.started", "Preparing preview", {}, "previewing");
      }
      const outcomeText = await executeReadOnly(deps, call.name, args);
      if ((call.name === "start_dev_server" || call.name === "get_preview_url") && outcomeText.success) {
        emit("agent.preview.ready", "Preview ready", { url: parseUrl(outcomeText.result) }, "previewing");
      }
      return outcomeText;
    }

    async function runCommand(
      toolName: string,
      command: string,
      args: Record<string, unknown>
    ): Promise<ToolOutcomeText> {
      const classified = classifyCommand(command);
      const isTest = toolName === "run_tests" || classified.kind === "test";
      const isBuild = classified.kind === "build";
      emit(
        isTest ? "agent.test.started" : "agent.command.started",
        isTest ? "Running tests" : classified.title,
        { command: command.slice(0, 300), kind: classified.kind },
        isTest ? "testing" : isBuild ? "building" : "executing"
      );

      const startedAt = Date.now();
      const executed = await executeReadOnly(deps, toolName, { ...args, command });
      const durationMs = Date.now() - startedAt;
      const summary = summarize(executed);

      emit(
        isTest ? "agent.test.completed" : "agent.command.completed",
        describeRun(isTest ? "Tests" : classified.title, executed, summary, durationMs),
        {
          exitCode: summary.exitCode,
          durationMs,
          failed: summary.failures ?? undefined,
          timedOut: summary.timedOut,
        },
        executed.success ? "verifying" : "diagnosing"
      );

      if (!executed.success) {
        emit("agent.status", "Diagnosing the failure", { exitCode: summary.exitCode }, "diagnosing");
      }
      return executed;
    }

    async function planMutation(
      call: ToolCall,
      args: Record<string, unknown>
    ): Promise<ToolOutcomeText> {
      const isRename = call.name === "rename_file";
      // rename_file declares oldPath/newPath, so reading args.path here would
      // silently target the empty string.
      const sourceRaw = isRename ? String(args.oldPath ?? "") : String(args.path ?? "");
      const targetRaw = isRename ? String(args.newPath ?? "") : String(args.path ?? "");

      const source = confinedPath(sourceRaw);
      if (!source) return { result: `Error: not a valid workspace path: ${sourceRaw}`, success: false };
      const target = confinedPath(targetRaw);
      if (!target) return { result: `Error: not a valid workspace path: ${targetRaw}`, success: false };

      if (isRename) {
        // A rename needs two writes and needs the SOURCE's bytes, so it is not
        // routed through resolveDesiredContent, which models one path.
        const current = await cachedRead(source);
        if (current === null) return { result: "Error: the file to rename does not exist", success: false };
        const destination = await cachedRead(target);
        if (destination !== null) return { result: `Error: ${target} already exists`, success: false };

        collector.plan({ path: target, kind: "create", newContent: current });
        collector.plan({ path: source, kind: "delete", newContent: null });
        // expectCurrent is what makes the batched apply safe: the runtime refuses
        // to write any path whose current bytes it does not already own.
        edits.push({ path: target, content: current, expectCurrent: null });
        edits.push({ path: source, content: null, expectCurrent: current });
      } else {
        const current = await cachedRead(target);
        const desired = resolveDesiredContent(call.name, { ...args, path: target }, current);
        if (!desired.ok) return { result: `Error: ${desired.error}`, success: false };
        collector.plan({ path: target, kind: desired.kind, newContent: desired.content });
        edits.push({ path: target, content: desired.content, expectCurrent: current });
      }

      cache.invalidateAll();
      pendingLabel ??= describeChanges([{ path: target }]);
      return { result: describePlanned(call.name, target), success: true };
    }

    async function applyEdits(
      requested: PlannedEdit[]
    ): Promise<{ changed: number; bytes: number; paths: string[] }> {
      const gate = budget.startExec();
      if (!gate.ok) {
        emit("agent.error", "Edits were not applied: runtime budget exhausted", { reason: gate.message }, "waiting");
        return { changed: 0, bytes: 0, paths: [] };
      }

      // Pre-images must be stored while the old bytes are still on disk.
      await commitCheckpoint(pendingLabel ?? describeChanges(requested));

      const mutations: FileMutation[] = requested.map((edit) => ({
        path: edit.path,
        content: edit.content,
        expectCurrent: edit.expectCurrent,
      }));

      let results;
      try {
        results = await workspace.applyFileMutations(mutations, { timeoutMs: budget.commandTimeoutMs(60_000) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit("agent.error", "The batched edit failed", { reason: message }, "failed");
        return { changed: 0, bytes: 0, paths: [] };
      }

      const applied = results.filter((item) => item.status === "restored" || item.status === "deleted");
      for (const item of results) {
        if (item.status === "conflict" || item.status === "error") {
          emit("agent.error", `Could not change ${shortName(item.path)}`, {
            path: item.path,
            reason: item.detail ?? item.status,
          });
        }
      }
      cache.invalidateAll();
      pendingLabel = null;
      return {
        changed: applied.length,
        bytes: requested.reduce((total, edit) => total + (edit.content?.length ?? 0), 0),
        paths: applied.map((item) => item.path),
      };
    }

    async function cachedRead(path: string): Promise<string | null> {
      const peeked = cache.peek(path);
      if (peeked.hit) return peeked.content;
      const gate = budget.startExec();
      if (!gate.ok) return null;
      const content = await workspace.readFile(path);
      cache.store(path, content);
      return content;
    }
  }

  async function commitCheckpoint(label: string): Promise<void> {
    if (collector.size === 0) return;
    const flushed = await collector.flush(workspace, projectId, runId, label);
    if (flushed.checkpoint) {
      checkpointId = flushed.checkpoint.id;
      emit("agent.undo.created", `Checkpoint recorded: ${flushed.checkpoint.label}`, {
        checkpointId: flushed.checkpoint.id,
        paths: flushed.checkpoint.files.map((file) => file.path),
      });
    }
    if (flushed.nonReversible.length > 0) {
      emit(
        "agent.status",
        `${flushed.nonReversible.length} file(s) cannot be auto-reverted`,
        {
          paths: flushed.nonReversible.map((entry) => entry.path),
          reason: flushed.nonReversible.map((entry) => entry.reason).join("; "),
        },
        "diagnosing"
      );
    }
  }

  if (outcome === "completed" && !finalContent && toolCalls === 0) {
    finalContent = "I did not make any changes. Tell me what you would like done.";
  }
  if (outcome === "completed" && !finalContent && filesChanged > 0) {
    finalContent = `Completed ${filesChanged} file change${filesChanged === 1 ? "" : "s"}.`;
    contentStreamed = true;
  }

  return {
    outcome,
    state: outcome === "completed" ? "completed" : outcome === "paused" ? "paused" : "failed",
    stopReason,
    content: finalContent,
    toolCalls,
    filesChanged,
    checkpointId,
    contentStreamed,
    iterations: budget.summary().iterations,
    execCalls: budget.summary().execCalls,
    runtimeActivations: budget.summary().activations,
    runtimeMs: budget.summary().runtimeMs,
  };
}

/* --------------------------------- helpers --------------------------------- */

/** "AI changed auth.ts and middleware.ts" — the label Undo is shown with. */
function describeChanges(files: Array<{ path: string }>): string {
  const names = files.map((file) => shortName(file.path));
  if (names.length === 0) return "AI changed no files";
  if (names.length === 1) return `AI changed ${names[0]}`;
  if (names.length <= 3) return `AI changed ${names.join(" and ")}`;
  return `AI changed ${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function shortName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Confine a tool-supplied path before it reaches the checkpoint layer or the
 * runtime. Delegates to the same validator the routes use: a bare
 * `startsWith("/workspace")` would accept `/workspacex` and would not decode
 * traversal sequences.
 */
function confinedPath(raw: string): string | null {
  const result = validatePath(raw);
  return result.valid ? result.normalized : null;
}

function mutationSubject(name: string, args: Record<string, unknown>): string | undefined {
  if (!isMutatingTool(name)) return undefined;
  return String(args.path ?? args.newPath ?? "") || undefined;
}

function describePlanned(name: string, path: string): string {
  const target = shortName(path) || "the file";
  if (name === "delete_file") return `Queued deletion of ${target}`;
  if (name === "rename_file") return `Queued rename to ${target}`;
  return `Queued change to ${target}`;
}

function buildTestCommand(filter: string): string {
  return filter ? `npm test -- ${filter}` : "npm test";
}

interface RunSummary {
  exitCode: number | null;
  failures: number | null;
  timedOut: boolean;
}

function summarize(outcome: ToolOutcomeText): RunSummary {
  const exitMatch = /exit code:\s*(-?\d+)/.exec(outcome.result);
  const exitCode = exitMatch?.[1] ? Number.parseInt(exitMatch[1], 10) : outcome.success ? 0 : null;
  return {
    exitCode,
    failures: parseFailureCount(outcome.result),
    timedOut: /timed out/i.test(outcome.result),
  };
}

function describeRun(
  label: string,
  outcome: ToolOutcomeText,
  summary: RunSummary,
  durationMs: number
): string {
  const seconds = `${(durationMs / 1000).toFixed(1)}s`;
  if (summary.timedOut) return `${label} timed out after ${seconds}`;
  if (outcome.success && summary.exitCode === 0) return `${label} passed in ${seconds}`;
  if (summary.failures !== null) {
    return `${label} failed: ${summary.failures} failure${summary.failures === 1 ? "" : "s"}`;
  }
  return `${label} failed (exit ${summary.exitCode ?? "unknown"}) in ${seconds}`;
}

function parseUrl(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { url?: string };
    return typeof parsed.url === "string" ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}
