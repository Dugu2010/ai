import { Router, Request, Response } from "express";
import { listProjects, createProject, getProjectByUser, updateProject, deleteProject } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import {
  acquireWorkspace,
  duplicateProjectWorkspace,
  isRuntimeConfigured,
  purgeRuntimeWorkspace,
  runtimeConfig,
  terminateRuntime,
} from "../lib/runtime.js";
import { MAX_REQUEST_BODY_SIZE } from "../lib/validation.js";
import { requestSandboxSlot } from "../lib/sandbox-queue.js";
import { volumeSubPath } from "@dai/modal";

const router = Router();
router.use(requireAuth);

/**
 * Bring a project's runtime up.
 *
 * The durable part is the per-project subPath of the shared workspace Volume,
 * which needs no compute; the Sandbox attached here is what makes the project
 * immediately usable (files, preview) and Modal's idleTimeoutMs reclaims it
 * when the developer walks away.
 */
export async function provisionSandbox(project: { id: string; slug: string; name: string }) {
  const { workspace } = await acquireWorkspace(project.id);
  const config = runtimeConfig();
  workspace.close();

  const updated = await updateProject(project.id, {
    runtimeVolumeSubPath: volumeSubPath(project.id),
    status: "ready",
    lastError: null,
  });
  return { updated, sandbox: { sandboxId: workspace.sandboxId, previewPorts: config.previewPorts } };
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const projects = await listProjects(user.userId);
    res.json(projects);
  } catch (error: any) {
    console.error("[projects:GET]", error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      res.status(413).json({ error: "Request body exceeds maximum size" });
      return;
    }

    const { slug, name, description } = req.body ?? {};
    if (!slug || !name || typeof slug !== "string" || typeof name !== "string") {
      res.status(400).json({ error: "slug and name required" });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
      res.status(400).json({
        error: "Slug must be 3-50 chars: lowercase letters, numbers, hyphens",
      });
      return;
    }

    const project = await createProject(user.userId, { slug, name, description });

    if (!isRuntimeConfigured()) {
      await updateProject(project.id, {
        lastError: "MODAL_TOKEN_ID/MODAL_TOKEN_SECRET not configured on backend",
      });
      res.status(201).json({
        ...project,
        status: "provisioning",
        lastError: "MODAL_TOKEN_ID/MODAL_TOKEN_SECRET not configured on backend",
      });
      return;
    }

    try {
      const slot = await requestSandboxSlot(user.userId, project.id, "create");
      if (!slot.acquired) {
        await updateProject(project.id, { status: "queued", lastError: `Queue full (${slot.activeCount}/10), your request has been queued` });
        res.status(201).json({ ...project, status: "queued", lastError: `Queue full (${slot.activeCount}/10), your request has been queued` });
        return;
      }
      const { updated } = await provisionSandbox(project);
      // A slot freed up: kick the worker to drain any queued create/resume jobs.
      const { processSandboxQueue } = await import("../lib/sandbox-queue.js");
      void processSandboxQueue();
      res.status(201).json({ ...updated });
    } catch (sandboxError: any) {
      console.error("[projects:POST] Sandbox provisioning failed:", sandboxError.message);
      await updateProject(project.id, { lastError: sandboxError.message });
      res.status(503).json({ error: sandboxError.message, status: "error" });
    }
  } catch (error: any) {
    console.error("[projects:POST]", error.message);
    const status = error.code === "23505" ? 409 : 500;
    res.status(status).json({ error: error.code === "23505" ? "You already have a project with this slug" : error.message });
  }
});

/**
 * Re-attach compute for a project whose Sandbox went away.
 *
 * Modal cannot resume a finished Sandbox, so this deliberately does not try:
 * the workspace Volume still holds every file and a new Sandbox mounts it.
 */
router.post("/:id/reprovision", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!isRuntimeConfigured()) {
      res.status(503).json({ error: "Modal credentials are not configured on the backend" });
      return;
    }

    if (project.sandboxId) {
      await terminateRuntime(project.id);
    }
    const { updated } = await provisionSandbox(project);
    res.json(updated);
  } catch (error: any) {
    console.error("[projects:reprovision]", error.message);
    res.status(error.statusCode ?? 500).json({ error: error.message });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  } catch (error: any) {
    console.error("[projects:id:GET]", error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Fork a project by copying its durable workspace into a new project subPath.
 *
 * The copy is server-side inside the Volume, so neither the source nor the
 * target needs a running Sandbox and no file bytes cross the control plane.
 */
router.post("/:id/fork", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!isRuntimeConfigured()) {
      res.status(503).json({ error: "Modal credentials are not configured on the backend" });
      return;
    }

    const newProject = await createProject(user.userId, {
      slug: `${project.slug}-fork`,
      name: `${project.name} (Fork)`,
      description: project.description ?? undefined,
    });

    try {
      await duplicateProjectWorkspace(project.id, newProject.id);
    } catch (copyError: any) {
      // Never leave a half-created fork behind after a failed copy.
      await deleteProject(newProject.id);
      throw copyError;
    }

    const updated = await updateProject(newProject.id, {
      runtimeProvider: "modal",
      runtimeVolumeSubPath: volumeSubPath(newProject.id),
      status: "provisioning",
    });

    res.json(updated);
  } catch (error: any) {
    console.error("[projects:fork]", error.message);
    res.status(error.statusCode ?? 500).json({ error: error.message });
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    // Terminate compute first, then discard the durable workspace. Purging is
    // best-effort: losing it must not strand the user on a failed deletion.
    try {
      await purgeRuntimeWorkspace(project.id);
    } catch (purgeError: any) {
      console.warn("[projects:DELETE] runtime purge failed:", purgeError.message);
    }
    await deleteProject(project.id);
    res.json({ success: true });
  } catch (error: any) {
    console.error("[projects:DELETE]", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
