import { Router, Request, Response } from "express";
import {
  getProjectByUser,
  getActiveConversation,
  createConversation,
  listMessages,
  addMessage,
} from "@dai/db";
import { createAgentRun, insertActivityEvent, updateAgentRun } from "@dai/db";
import { NIMClient, type ChatMessage } from "@dai/nim";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { resolveNimConfig } from "../lib/nim-config.js";
import { validatePath } from "../lib/validation.js";
import {
  acquireWorkspace,
  isRuntimeConfigured,
  releaseWorkspace,
  runtimeDefaultPort,
} from "../lib/runtime.js";
import { DEFAULT_BUDGET_LIMITS, RuntimeBudget } from "../lib/runtime-policy.js";
import { LoopDetector } from "../lib/loop-detector.js";
import { createActivityEmitter, type ActivityEvent } from "../lib/activity.js";
import { runAgentLoop } from "../lib/agent-loop.js";
import { isCancelled, registerCancellation, unregisterCancellation } from "../lib/cancellations.js";

const router = Router();
router.use(requireAuth);

const SYSTEM_PROMPT = [
  "You are DAI, an expert coding agent working inside a project sandbox.",
  "Project files live under /workspace. Use the provided tools to inspect, create, edit, and run code.",
  "Prefer edit_file for small changes and write_file for new files.",
  "Run tests or a build to verify a change before claiming it works.",
  "Never describe reasoning you did not perform, and never claim a command passed without running it.",
].join(" ");

function writeSSE(res: Response, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

router.post("/:id/agent", async (req: Request, res: Response) => {
  let workspace: Awaited<ReturnType<typeof acquireWorkspace>>["workspace"] | null = null;
  let runId: string | null = null;

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

    // Attach compute BEFORE the SSE headers, so an unavailable runtime is a
    // structured 503 rather than a half-open stream.
    if (!isRuntimeConfigured()) {
      res.status(503).json({
        error: "No execution runtime is configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the backend.",
        status: "error",
      });
      return;
    }
    try {
      const acquired = await acquireWorkspace(project.id);
      workspace = acquired.workspace;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sandbox is not available. Please try again.";
      res.status((error as { statusCode?: number }).statusCode ?? 503).json({ error: message, status: "error" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const nimConfig = await resolveNimConfig(user.userId);
    const nim = new NIMClient(nimConfig.apiKey, nimConfig.baseURL, nimConfig.model);

    let convId: string = conversationId;
    if (!convId) {
      const existing = await getActiveConversation(project.id);
      convId = existing
        ? existing.id
        : (await createConversation(project.id, { title: "New conversation", model: nimConfig.model })).id;
    }
    const history = await listMessages(convId);

    const run = await createAgentRun({
      projectId: project.id,
      conversationId: convId,
      userId: user.userId,
      prompt: message,
      budget: {},
      sandboxId: workspace.sandboxId,
    });
    runId = run.id;

    const budget = new RuntimeBudget(DEFAULT_BUDGET_LIMITS);
    const loop = new LoopDetector();

    const emitter = createActivityEmitter({
      runId: run.id,
      projectId: project.id,
      persist: (event) => {
        void insertActivityEvent(run.id, project.id, event).catch((error: unknown) => {
          console.error("[agent] activity persist failed:", error instanceof Error ? error.message : error);
        });
      },
      publish: (frame) => {
        writeSSE(res, "activity", frame as unknown as Record<string, unknown>);
        for (const [name, payload] of frameForLegacyStream(frame)) writeSSE(res, name, payload);
      },
    });

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

    registerCancellation(run.id);
    const result = await runAgentLoop({
      projectId: project.id,
      runId: run.id,
      prompt: message,
      workspace,
      nim,
      messages,
      emit: emitter.emit,
      budget,
      loop,
      previewPort: runtimeDefaultPort(),
      aborted: () => isCancelled(run.id),
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

    if (result.contentStreamed && result.content) {
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
    registerCancellation(runId);
    await updateAgentRun(runId, {
      state: "paused",
      outcome: "cancelled",
      stopReason: "Stopped by you.",
    });
    res.json({ success: isCancelled(runId), runId });
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
    const { listAgentRuns, listActivityEvents, findLatestAppliedCheckpoint, findNextUndoneCheckpoint } = await import("@dai/db");
    const runs = await listAgentRuns(project.id, 1);
    const run = runs[0] ?? null;
    const events = run ? await listActivityEvents(run.id) : [];
    const limits = DEFAULT_BUDGET_LIMITS;
    res.json({
      run,
      events,
      limits,
      canUndo: Boolean(await findLatestAppliedCheckpoint(project.id)),
      canRedo: Boolean(await findNextUndoneCheckpoint(project.id)),
      canContinue: run?.outcome === "paused" || run?.outcome === "budget_exhausted",
      canRetryDifferently: run?.outcome === "paused",
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to read run status" });
  }
});

export default router;
