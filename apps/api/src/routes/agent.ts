import { Router, Request, Response } from "express";
import {
  getProjectByUser,
  updateProject,
  getActiveConversation,
  getConversationForProject,
  createConversation,
  listMessages,
  addMessage,
} from "@dai/db";
import { createAgentRun, getAgentRun, insertActivityEvent, updateAgentRun } from "@dai/db";
import { NIMClient, type ChatMessage } from "@dai/nim";
import type { ActivityEventType, AgentState } from "@dai/types";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { resolveNimConfig } from "../lib/nim-config.js";
import {
  acquireWorkspace,
  assertWithinStorageQuota,
  isRuntimeConfigured,
  recordWorkspaceUsage,
  releaseWorkspace,
  runtimeBudgetConfig,
  runtimeDefaultPort,
  runtimeProvider,
} from "../lib/runtime.js";
import { DEFAULT_BUDGET_LIMITS, RuntimeBudget } from "../lib/runtime-policy.js";
import { configFromEnv as vercelConfigFromEnv } from "@dai/vercel";
import { LoopDetector } from "../lib/loop-detector.js";
import { createActivityEmitter, type ActivityEvent } from "../lib/activity.js";
import { runAgentLoop } from "../lib/agent-loop.js";
import { isCancelled, registerCancellation, unregisterCancellation } from "../lib/cancellations.js";

const router = Router();
router.use(requireAuth);

/**
 * The economics are part of the instructions.
 *
 * Reading, searching and editing files costs nothing on this runtime; running a
 * command does, against a small fixed monthly allowance that suspends the
 * product when it runs out. A model told only what it may do will use a shell to
 * `cat` a file it could have read, so the prompt says which door is free.
 */
const SYSTEM_PROMPT = [
  "You are DAI, an expert coding agent working inside a project sandbox.",
  "Project files live under /workspace. Use the provided tools to inspect, create, edit, and run code.",
  "Prefer edit_file for small changes and write_file for new files.",
  "Reading a file and writing a file are cheap. Everything else — listing a directory, searching by",
  "name or content, git, and running a command — executes inside the sandbox and is metered against a",
  "small monthly compute allowance that cannot be topped up. So read the files you already know about",
  "instead of listing to find them, and run a command only when a change must actually be executed:",
  "installing, building, or testing. Never use a command to inspect something a file tool can answer,",
  "and do not start the dev server to look at a result you can read.",
  "When a real check is warranted, run the project's tests or build once and report what actually happened.",
  "Never describe reasoning you did not perform, and never claim a command passed without running it.",
].join(" ");

function writeSSE(res: Response, event: string, data: Record<string, unknown>): void {
  // The client owns a long-lived stream and may vanish at any moment; writing to
  // a dead socket emits an error on the response rather than throwing, so an
  // unhandled one could take the process down mid-run.
  if (res.writableEnded || !res.writable) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Connection is gone; the run itself is stopped via the close listener.
  }
}

/**
 * Bridges the loop's activity feed onto the wire.
 *
 * The legacy `assistant_delta` / `tool_call` / `tool_result` frames are still
 * emitted so an older client keeps working, while `activity` frames carry the
 * high-level timeline the redesigned UI renders.
 */
function frameForLegacyStream(event: ActivityEvent): Array<[string, Record<string, unknown>]> {
  const id = `cmd-${event.seq}`;
  switch (event.type) {
    case "agent.command.started":
    case "agent.test.started":
      return [
        [
          "tool_call",
          { id, name: typeof event.detail.command === "string" ? event.detail.command : "command", args: {} },
        ],
      ];
    case "agent.command.completed":
    case "agent.test.completed":
      return [
        [
          "tool_result",
          { id, status: event.state === "diagnosing" ? "error" : "success", preview: event.title },
        ],
      ];
    default:
      return [];
  }
}

/**
 * Remember that this project needs a bigger machine next time.
 *
 * Nothing here changes the run in flight — a live sandbox cannot be resized, and
 * re-acquiring mid-run would lose the workspace it is working in. The tier is
 * persisted so the *next* acquisition starts at the size this one proved it
 * needed, which is what stops a project re-discovering the same timeout daily.
 * Governor rules (weekly cap, throttle levels, top tier) live in cost-governor.
 */
async function escalateTier(project: { id: string; runtimeResourceTier?: number }): Promise<void> {
  try {
    const config = runtimeBudgetConfig();
    if (!config) return;
    const { nextTierAfterTimeout, readHeadroom } = await import("../lib/cost-governor.js");
    const headroom = await readHeadroom(config.budget);
    const current = project.runtimeResourceTier ?? 0;
    const next = await nextTierAfterTimeout(project.id, current, vercelConfigFromEnv(), headroom.level);
    if (next === current) return;
    await updateProject(project.id, { runtimeResourceTier: next });
  } catch (error) {
    // Sizing is an optimisation; never let it fail a run that already finished.
    console.warn("[agent] escalation check failed:", error instanceof Error ? error.message : error);
  }
}

router.post("/:id/agent", async (req: Request, res: Response) => {
  let workspace: Awaited<ReturnType<typeof acquireWorkspace>>["workspace"] | null = null;
  let runId: string | null = null;

  // A browser that goes away mid-run must not leave the loop spending activations
  // and holding a Sandbox with nobody watching it.
  const onClientGone = () => {
    if (runId) registerCancellation(runId);
  };

  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const { message, conversationId } = req.body ?? {};
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message required" });
      return;
    }

    if (!isRuntimeConfigured()) {
      res.status(503).json({
        error: "No execution runtime is configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the backend.",
        status: "error",
      });
      return;
    }

    const nimConfig = await resolveNimConfig(user.userId);
    const nim = new NIMClient(nimConfig.apiKey, nimConfig.baseURL, nimConfig.model);

    // A caller chooses which conversation to continue, so it has to be verified
    // against this project: the history below is loaded from it and the run's
    // messages are written to it.
    let convId: string;
    if (typeof conversationId === "string" && conversationId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId);
      const owned = isUuid && (await getConversationForProject(conversationId, project.id));
      if (!owned) {
        res.status(400).json({ error: "conversationId does not belong to this project" });
        return;
      }
      convId = owned.id;
    } else {
      const existing = await getActiveConversation(project.id);
      convId = existing
        ? existing.id
        : (await createConversation(project.id, { title: "New conversation", model: nimConfig.model })).id;
    }
    const history = await listMessages(convId);

    const budget = new RuntimeBudget(DEFAULT_BUDGET_LIMITS);
    const loop = new LoopDetector();

    // The run row is written before compute is touched, so a run that never gets
    // a Sandbox still leaves a record carrying the reason.
    const run = await createAgentRun({
      projectId: project.id,
      conversationId: convId,
      userId: user.userId,
      prompt: message,
      budget: budget.limits as unknown as Record<string, unknown>,
      sandboxId: null,
    });
    runId = run.id;

    // Attach compute BEFORE the SSE headers, so an unavailable runtime is a
    // structured 503 rather than a half-open stream.
    let reattached = false;
    try {
      // Free check first: a project already over its storage allowance should
      // not pay for a Sandbox to discover that again.
      await assertWithinStorageQuota(project.id);
      const acquired = await acquireWorkspace(project.id);
      workspace = acquired.workspace;
      reattached = acquired.reattached;
      // Meter the truth: reattaching to a Sandbox that is already running starts
      // no compute, so it consumes no activation. A run acquires exactly once,
      // which is what actually bounds activations per run.
      if (!reattached) budget.startActivation();
      await updateAgentRun(run.id, { sandboxId: workspace.sandboxId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Sandbox is not available. Please try again.";
      await updateAgentRun(run.id, {
        state: "failed",
        outcome: "failed",
        stopReason: reason,
        lastError: reason,
        finishedAt: new Date().toISOString(),
      }).catch(() => undefined);
      res.status((error as { statusCode?: number }).statusCode ?? 503).json({ error: reason, status: "error" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.on("close", onClientGone);

    // `emit` is synchronous, so the inserts it starts are tracked here and drained
    // before the stream closes: the client reads `/status` the moment it does, and
    // an event still in flight would make that authoritative read come back
    // with the tail of the timeline missing.
    const pendingActivity: Promise<void>[] = [];
    const emitter = createActivityEmitter({
      runId: run.id,
      projectId: project.id,
      persist: (event) => {
        pendingActivity.push(
          insertActivityEvent(run.id, project.id, event).catch((error: unknown) => {
            console.error("[agent] activity persist failed:", error instanceof Error ? error.message : error);
          })
        );
      },
      publish: (frame) => {
        writeSSE(res, "activity", frame as unknown as Record<string, unknown>);
        for (const [name, payload] of frameForLegacyStream(frame)) writeSSE(res, name, payload);
      },
    });

    // Reported as soon as the stream can carry it. Whether this run needed a new
    // Sandbox or reused a live one is the cost fact the user is owed.
    if (!reattached) {
      emitter.emit("agent.runtime.requested", "Starting a runtime for this project", {}, "waiting");
    }
    emitter.emit(
      "agent.runtime.started",
      reattached ? "Reusing the project's running runtime" : "Runtime ready",
      { sandboxId: workspace.sandboxId, reused: reattached, activations: budget.summary().activations },
      "inspecting"
    );

    await addMessage(convId, { role: "user", content: message, projectId: project.id });

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history
        .slice(-40)
        .filter((m) => m.role === "user" || m.role === "assistant")
        // Tool-call-only turns persist a null content; replaying them injects
        // blank turns into the model's context.
        .filter((m) => m.role === "user" || (m.content ?? "").trim() !== "")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content || "" })),
      { role: "user", content: message },
    ];

    // Set when a command exhausts its deadline: the one signal that a bigger
    // machine might actually help rather than just fail the same way faster.
    let commandTimedOut = false;
    // The flag in lib/cancellations.ts means "the user asked this run to stop",
    // and only the stop route sets it. Registering a fresh run here would mark it
    // cancelled before the loop's first check and end every run immediately.
    const result = await runAgentLoop({
      projectId: project.id,
      onCommandTimeout: () => {
        commandTimedOut = true;
      },
      runId: run.id,
      prompt: message,
      workspace,
      nim,
      messages,
      emit: emitter.emit,
      budget,
      loop,
      previewPort: runtimeDefaultPort(),
      // Lets `get_project_status` answer with the month's remaining compute, so
      // the model can choose to finish with file tools instead of spending.
      spendReport: async () => {
        try {
          const { describeHeadroom, readHeadroom } = await import("../lib/cost-governor.js");
          const config = runtimeBudgetConfig();
          return config ? describeHeadroom(await readHeadroom(config.budget), config.budget) : "";
        } catch {
          return "";
        }
      },
      // Checked per call rather than once at acquire: a run can be long, and the
      // month's state is what decides, not the state when it started.
      previewGate: async () => {
        try {
          if (!runtimeBudgetConfig()) return null;
          const { previewRefusalReason } = await import("../lib/cost-governor.js");
          return await previewRefusalReason();
        } catch {
          return null;
        }
      },
      aborted: () => isCancelled(run.id),
      onAssistantText: (text) => writeSSE(res, "assistant_delta", { text }),
      recordToolCall: async (entry) => {
        await addMessage(convId, {
          role: "tool",
          content: entry.result,
          projectId: project.id,
          toolName: entry.name,
          toolArgs: entry.args,
          toolResult: { success: entry.success, result: entry.result },
        });
      },
    });

    // Reuse the Sandbox this run already holds to take the next measurement, so
    // the quota stays honest without an extra activation later.
    await recordWorkspaceUsage(workspace, project.id).catch(() => null);

    // A tool-only turn produces no prose at all, so summarise it here; anything
    // the model actually said has already been streamed by onAssistantText.
    if (!result.contentStreamed && result.content) {
      writeSSE(res, "assistant_delta", { text: result.content });
    }

    const finalMessage = await addMessage(convId, {
      role: "assistant",
      content: result.content || "(no content returned)",
      projectId: project.id,
    });

    await updateAgentRun(run.id, {
      state: result.state,
      outcome: result.outcome,
      stopReason: result.stopReason ?? undefined,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      execCalls: result.execCalls,
      runtimeActivations: result.runtimeActivations,
      runtimeMs: result.runtimeMs,
      filesChanged: result.filesChanged,
      summary: result.content?.slice(0, 2000) ?? undefined,
      finishedAt: new Date().toISOString(),
    });

    if (result.checkpointId) {
      emitter.emit("agent.undo.created", "Undo is available for this run", {
        checkpointId: result.checkpointId,
      });
    }
    emitter.emit(
      result.outcome === "completed" ? "agent.completed" : "agent.error",
      result.outcome === "completed" ? "Task complete" : (result.stopReason ?? "Task stopped"),
      { outcome: result.outcome, reason: result.stopReason ?? undefined },
      result.state
    );

    // A timeout is the only evidence the sizing rule acts on, so persist the
    // verdict before the stream closes and the next run chooses its machine.
    if (commandTimedOut) await escalateTier(project);

    // Every event the user watched has to be readable from `/status` by the time
    // this stream closes, so drain the detached writes first.
    await Promise.all(pendingActivity);

    writeSSE(res, "done", {
      runId: run.id,
      conversationId: convId,
      messageId: finalMessage.id,
      outcome: result.outcome,
      stopReason: result.stopReason,
      checkpointId: result.checkpointId,
    });
    res.end();
  } catch (error) {
    console.error("[agent]", error instanceof Error ? error.message : error);
    if (!res.headersSent) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      res
        .status(status)
        .json({ error: error instanceof Error ? error.message : "Agent request failed", status: "error" });
      return;
    }
    try {
      writeSSE(res, "error", { message: error instanceof Error ? error.message : "Agent request failed" });
      writeSSE(res, "done", { outcome: "failed", stopReason: null });
      res.end();
    } catch {
      // The response is already broken.
    }
  } finally {
    res.removeListener("close", onClientGone);
    if (workspace) releaseWorkspace(workspace);
    if (runId) unregisterCancellation(runId);
  }
});

/**
 * Stop a running task. The loop checks this flag between iterations, so a
 * stopped run ends cleanly and its checkpoint remains available for undo.
 */
router.post("/:id/agent/stop", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const { runId } = req.body ?? {};
    if (typeof runId !== "string" || !runId) {
      res.status(400).json({ error: "runId required" });
      return;
    }
    // The run must belong to this project. A caller-supplied identifier alone
    // would let anyone cancel another user's run by guessing its id.
    const run = await getAgentRun(runId);
    if (!run || run.projectId !== project.id) {
      res.status(404).json({ error: "Run not found for this project" });
      return;
    }
    // Nobody is left to observe the flag once the loop has exited, and only the
    // owning request clears it — stopping a finished run would leak the id for
    // the lifetime of the process.
    if (run.finishedAt) {
      res.status(409).json({ error: "That run has already finished.", code: "already_finished" });
      return;
    }
    // Only the request is recorded here. Writing `cancelled` now would claim a
    // result the loop has not produced yet, and would lose to the loop's own
    // final write whenever the last step finished first.
    registerCancellation(runId);
    res.json({ success: true, runId, stopping: isCancelled(runId) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to stop the run" });
  }
});

/** Latest run plus its timeline — what the UI loads on open and on reconnect. */
router.get("/:id/agent/status", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const {
      listAgentRuns,
      listActivityEvents,
      hasCheckpointWithStatus,
    } = await import("@dai/db");
    const runs = await listAgentRuns(project.id, 1);
    const run = runs[0] ?? null;
    // Columns are flat and snake_case; the browser's `AgentRun`/`ActivityEvent`
    // types want nested `counts` and a camelCase `type`. Handing out raw rows
    // made every finished run render a zeroed budget meter and a timeline whose
    // events had no kind, because this read replaces the streamed ones.
    const wireRun = run && {
      id: run.id,
      projectId: run.projectId,
      conversationId: run.conversationId,
      prompt: run.prompt,
      state: run.state,
      outcome: run.outcome,
      stopReason: run.stopReason,
      counts: {
        iterations: run.iterations,
        toolCalls: run.toolCalls,
        execCalls: run.execCalls,
        runtimeActivations: run.runtimeActivations,
        runtimeMs: run.runtimeMs,
        filesChanged: run.filesChanged,
      },
      sandboxId: run.sandboxId,
      summary: run.summary,
      lastError: run.lastError,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    };
    const rows = run ? await listActivityEvents(run.id) : [];
    const events = rows.map((row) => ({
      id: 0,
      runId: run!.id,
      seq: row.seq,
      type: row.event_type as ActivityEventType,
      state: row.state as AgentState | null,
      title: row.title,
      detail: row.detail ?? {},
      createdAt: row.created_at,
    }));
    const limits = DEFAULT_BUDGET_LIMITS;
    const [canUndo, canRedo] = await Promise.all([
      hasCheckpointWithStatus(project.id, "applied"),
      hasCheckpointWithStatus(project.id, "undone"),
    ]);
    res.json({
      run: wireRun,
      events,
      limits,
      canUndo,
      canRedo,
      canContinue: run?.outcome === "paused" || run?.outcome === "budget_exhausted",
      canRetryDifferently: run?.outcome === "paused",
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to read run status" });
  }
});

export default router;
