import { Router, Request, Response } from "express";
import {
  getProjectByUser,
  insertActivityEvent,
  listAgentRuns,
  listCheckpoints,
} from "@dai/db";
import type { Workspace } from "@dai/modal";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { acquireWorkspace, isRuntimeConfigured, releaseWorkspace } from "../lib/runtime.js";
import { redoLatest, undoLatest, type RestoreOutcome } from "../lib/checkpoint-service.js";
import { createActivityEmitter } from "../lib/activity.js";

const router = Router();
router.use(requireAuth);

/**
 * Undo and redo.
 *
 * These are user-initiated, so unlike an agent run they may attach compute on
 * demand: restoring files has to happen inside the Sandbox, because on this
 * provider that is the only place project bytes can be written. The work is
 * still one batched command, so a 15-file checkpoint costs one call, not fifteen.
 */
async function withWorkspace<T>(
  projectId: string,
  userId: string,
  fn: (workspace: Workspace) => Promise<T>
): Promise<T> {
  const project = await getProjectByUser(projectId, userId);
  if (!project) throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  if (!isRuntimeConfigured()) {
    throw Object.assign(new Error("No execution runtime is configured, so files cannot be restored."), {
      statusCode: 503,
    });
  }
  const { workspace } = await acquireWorkspace(project.id);
  try {
    return await fn(workspace);
  } finally {
    releaseWorkspace(workspace);
  }
}

/**
 * Append the restore to the latest run's timeline so the activity feed stays
 * truthful: an undo really happened, and reloading the page must show it.
 */
async function recordRestore(projectId: string, outcome: RestoreOutcome): Promise<void> {
  const runs = await listAgentRuns(projectId, 1);
  const run = runs[0];
  if (!run) return;
  const emitter = createActivityEmitter({
    runId: run.id,
    projectId,
    persist: (event) => {
      void insertActivityEvent(run.id, projectId, event).catch(() => undefined);
    },
    publish: () => undefined,
  });
  const changed = outcome.results.filter(
    (result) => result.status === "restored" || result.status === "deleted"
  );
  emitter.emit(
    "agent.undo.restored",
    outcome.message ?? `Undid ${outcome.label} (${changed.length} file${changed.length === 1 ? "" : "s"})`,
    {
      checkpointId: outcome.checkpointId,
      paths: changed.map((result) => result.path),
      status: outcome.status,
    }
  );
}

function respond(res: Response, outcome: RestoreOutcome): void {
  // `blocked` is a real refusal with a reason, not a silent no-op.
  if (outcome.status === "blocked") {
    res.status(409).json({ error: outcome.message ?? "This checkpoint cannot be reverted.", code: "blocked" });
    return;
  }
  res.json(outcome);
}

router.post("/:projectId/undo", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const projectId = req.params.projectId!;
    const outcome = await withWorkspace(projectId, user.userId, (workspace) => undoLatest(workspace, projectId));
    await recordRestore(projectId, outcome);
    respond(res, outcome);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Undo failed" });
  }
});

router.post("/:projectId/redo", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const projectId = req.params.projectId!;
    const outcome = await withWorkspace(projectId, user.userId, (workspace) => redoLatest(workspace, projectId));
    respond(res, outcome);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Redo failed" });
  }
});

/** The Changes panel: what each checkpoint touched and whether it is reversible. */
router.get("/:projectId/checkpoints", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.projectId!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    // Summaries only: the list is what the Changes panel renders, and pulling
    // every stored pre-image would read megabytes of text nobody asked for.
    const rows = await listCheckpoints(project.id);
    res.json({
      checkpoints: rows.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        reversible: row.reversible,
        note: row.note,
        createdAt: row.createdAt,
        undoneAt: row.undoneAt,
        fileCount: row.fileCount,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to read checkpoints" });
  }
});

export default router;
