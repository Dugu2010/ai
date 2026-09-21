import { Router, Request, Response } from "express";
import { getProjectByUser, updateProject } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { validatePath, MAX_REQUEST_BODY_SIZE, MAX_FILE_READ_SIZE } from "../lib/validation.js";
import { acquireWorkspace, isRuntimeConfigured, releaseWorkspace, runtimeDefaultPort, runtimeState, terminateRuntime } from "../lib/runtime.js";
import { MAX_ACTIVE_SANDBOXES as MAX_ACTIVE_RUNTIME_PROJECTS } from "../lib/sandbox-queue.js";
import type { Workspace } from "@dai/modal";
import type { Project } from "@dai/types";

const router = Router();
router.use(requireAuth);

const DEV_PORT = runtimeDefaultPort();

/** Projects untouched this long are surfaced as cold. */
const ARCHIVE_AFTER_DAYS = 7;

function isArchived(lastAccessedAt: string | null): boolean {
  if (!lastAccessedAt) return false;
  const daysSinceAccess = (Date.now() - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceAccess > ARCHIVE_AFTER_DAYS;
}

function runtimeNotConfigured(res: Response): boolean {
  if (isRuntimeConfigured()) return false;
  res.status(503).json({
    error: "No execution runtime is configured. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the backend.",
    status: "error",
  });
  return true;
}

/**
 * Resolve the project and attach it to a live Sandbox.
 *
 * `acquireWorkspace` reattaches to the stored Sandbox while it is still
 * running and otherwise mounts a new one over the same durable Volume, so this
 * never provisions compute per request beyond what the project already needs.
 * The returned handle is released by `close()`, which leaves the Sandbox up.
 */
async function workspaceForProject(
  projectId: string,
  userId: string
): Promise<{ workspace: Workspace; project: Project } | { error: string; status: number } | null> {
  const project = await getProjectByUser(projectId, userId);
  if (!project) return null;
  if (!project.sandboxId && project.runtimeProvider !== "modal") {
    return { status: 409, error: "Project sandbox is not provisioned yet" };
  }
  const { workspace } = await acquireWorkspace(project.id);
  return { workspace, project };
}

// GET /api/workspace/:projectId?path=/workspace — list directory
router.get("/:projectId", async (req: Request, res: Response) => {
  let workspace: Workspace | null = null;
  try {
    if (runtimeNotConfigured(res)) return;
    const user = getAuthUser(req);
    const ctx = await workspaceForProject(req.params.projectId!, user.userId);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    workspace = ctx.workspace;
    const path = (req.query.path as string) || "/workspace";
    const validation = validatePath(path);
    if (!validation.valid || !validation.normalized) {
      res.status(403).json({ error: validation.error || "Invalid path" });
      return;
    }
    res.json(await workspace.listFiles(validation.normalized));
  } catch (error: any) {
    console.error("[workspace:GET]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (workspace) releaseWorkspace(workspace);
  }
});

// POST /api/workspace/:projectId — { action: write|create|delete|rename|move, path, content?, newPath? }
router.post("/:projectId", async (req: Request, res: Response) => {
  let workspace: Workspace | null = null;
  try {
    if (runtimeNotConfigured(res)) return;
    const user = getAuthUser(req);
    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      res.status(413).json({ error: "Request body exceeds maximum size" });
      return;
    }
    const ctx = await workspaceForProject(req.params.projectId!, user.userId);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    workspace = ctx.workspace;
    const { action, path, content, newPath } = req.body ?? {};
    if (!path || typeof path !== "string") {
      res.status(400).json({ error: "Path is required" });
      return;
    }
    const pathValidation = validatePath(path);
    if (!pathValidation.valid || !pathValidation.normalized) {
      res.status(400).json({ error: pathValidation.error || "Invalid path" });
      return;
    }
    switch (action) {
      case "write":
      case "create": {
        await workspace.writeFile(pathValidation.normalized, typeof content === "string" ? content : "");
        break;
      }
      case "delete": {
        await workspace.remove(pathValidation.normalized);
        break;
      }
      case "rename":
      case "move": {
        if (!newPath || typeof newPath !== "string") {
          res.status(400).json({ error: "newPath is required for rename" });
          return;
        }
        const newPathValidation = validatePath(newPath);
        if (!newPathValidation.valid || !newPathValidation.normalized) {
          res.status(400).json({ error: newPathValidation.error || "Invalid new path" });
          return;
        }
        await workspace.rename(pathValidation.normalized, newPathValidation.normalized);
        break;
      }
      default:
        res.status(400).json({ error: `Unknown action: ${action}` });
        return;
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("[workspace:POST]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (workspace) releaseWorkspace(workspace);
  }
});

// GET /api/workspace/:projectId/file?path=... — read file contents
router.get("/:projectId/file", async (req: Request, res: Response) => {
  let workspace: Workspace | null = null;
  try {
    if (runtimeNotConfigured(res)) return;
    const user = getAuthUser(req);
    const ctx = await workspaceForProject(req.params.projectId!, user.userId);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    workspace = ctx.workspace;
    const path = (req.query.path as string) || "";
    const validation = validatePath(path);
    if (!validation.valid || !validation.normalized) {
      res.status(403).json({ error: validation.error || "Invalid path" });
      return;
    }
    const content = await workspace.readFile(validation.normalized);
    if (content === null) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (content.length > MAX_FILE_READ_SIZE) {
      res.status(413).json({ error: "File exceeds maximum read size" });
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content);
  } catch (error: any) {
    console.error("[workspace:file]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (workspace) releaseWorkspace(workspace);
  }
});

// GET /api/workspace/:projectId/status — runtime state WITHOUT provisioning.
// Polls the stored Sandbox id; Modal's `poll()` is the only non-waking liveness
// signal, so "running" here means the VM is genuinely accepting commands.
router.get("/:projectId/status", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.projectId!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const archived = isArchived(project.lastAccessedAt);
    const state = await runtimeState(project.id);
    // Modal has no hibernation, so a stopped Sandbox is reported with the
    // existing "hibernated" vocabulary: no live compute, workspace intact.
    const reported = state === "stopped" ? "hibernated" : state;
    res.json({
      state: reported,
      sandboxId: project.sandboxId,
      runtimeProvider: project.runtimeProvider,
      previewUrl: project.previewUrl,
      devServerRunning: state === "running" ? project.devServerRunning : false,
      devServerPort: project.previewPort,
      lastError: project.lastError,
      isHibernated: state !== "running",
      isArchived: archived,
      bootupType: project.bootupType,
      isUpToDate: project.isUpToDate,
    });
  } catch (error: any) {
    console.error("[workspace:status]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/preview — start the dev server, wait for the
// port to actually listen, then return an authenticated tunnel URL.
router.post("/:projectId/preview", async (req: Request, res: Response) => {
  let workspace: Workspace | null = null;
  try {
    if (runtimeNotConfigured(res)) return;
    const user = getAuthUser(req);
    const ctx = await workspaceForProject(req.params.projectId!, user.userId);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    workspace = ctx.workspace;
    const { command, port } = req.body ?? {};
    const devPort = Number(port) || DEV_PORT;
    const devCommand = typeof command === "string" && command.trim() ? command.trim() : "npm run dev";
    if (devPort < 1 || devPort > 65535) {
      res.status(400).json({ error: "port must be 1-65535" });
      return;
    }

    const server = await workspace.startDevServer({ command: devCommand, port: devPort });
    const preview = await workspace.getPreviewUrl(devPort);

    await updateProject(ctx.project.id, {
      previewPort: devPort,
      previewUrl: preview.url,
      devServerRunning: true,
      status: "ready",
      lastError: null,
    });

    res.json({
      url: preview.url,
      // Modal requires this token to reach the tunnel; the proxy endpoint hands
      // it to the browser so the preview is not a public URL.
      token: preview.token,
      port: devPort,
      reused: server.reused,
      portUp: server.ready,
      note: server.ready ? undefined : "Dev server is starting; the URL may take a few more seconds.",
    });
  } catch (error: any) {
    console.error("[workspace:preview]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (workspace) releaseWorkspace(workspace);
  }
});

// POST /api/workspace/:projectId/preview/proxy — resume-or-create, ensure the
// dev server, then return the authenticated tunnel URL. The browser owns its
// own loading state while this is in flight.
router.post("/:projectId/preview/proxy", async (req: Request, res: Response) => {
  let workspace: Workspace | null = null;
  try {
    if (runtimeNotConfigured(res)) return;
    const user = getAuthUser(req);
    const ctx = await workspaceForProject(req.params.projectId!, user.userId);
    if (!ctx) {
      res.json({ url: null, isHibernated: false, wasHibernated: false, isArchived: false, bootupType: null, devServerRunning: false });
      return;
    }
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    workspace = ctx.workspace;
    const port = ctx.project.previewPort || DEV_PORT;
    let devServerRunning = false;
    try {
      const server = await workspace.startDevServer({ command: "npm run dev", port });
      devServerRunning = server.ready;
    } catch (error: any) {
      console.warn(`[workspace:preview-proxy] dev server not started: ${error?.message ?? error}`);
    }
    const preview = await workspace.getPreviewUrl(port);
    await updateProject(ctx.project.id, {
      previewUrl: preview.url,
      previewPort: port,
      devServerRunning,
      lastAccessedAt: new Date().toISOString(),
    });
    res.json({
      url: preview.url,
      token: preview.token,
      isHibernated: false,
      wasHibernated: ctx.project.isHibernated,
      isArchived: isArchived(ctx.project.lastAccessedAt),
      bootupType: ctx.project.bootupType,
      devServerRunning,
    });
  } catch (error: any) {
    console.error("[workspace:preview-proxy]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (workspace) releaseWorkspace(workspace);
  }
});

// POST /api/workspace/:projectId/preview/stop
router.post("/:projectId/preview/stop", async (req: Request, res: Response) => {
  let workspace: Workspace | null = null;
  try {
    if (runtimeNotConfigured(res)) return;
    const user = getAuthUser(req);
    const ctx = await workspaceForProject(req.params.projectId!, user.userId);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if ("error" in ctx) {
      res.status(ctx.status).json({ error: ctx.error });
      return;
    }
    workspace = ctx.workspace;
    await workspace.stopDevServer(ctx.project.previewPort || DEV_PORT);
    await updateProject(ctx.project.id, { devServerRunning: false });
    res.json({ success: true });
  } catch (error: any) {
    console.error("[workspace:preview:stop]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    if (workspace) releaseWorkspace(workspace);
  }
});

// POST /api/workspace/:projectId/restart — drop the Sandbox and mount a fresh
// one. Modal cannot resume a finished Sandbox, so restart means "terminate and
// recreate over the same Volume"; files survive because they live in the Volume.
router.post("/:projectId/restart", async (req: Request, res: Response) => {
  try {
    if (runtimeNotConfigured(res)) return;
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.projectId!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await terminateRuntime(project.id);
    const { workspace } = await acquireWorkspace(project.id);
    const sandboxId = workspace.sandboxId;
    releaseWorkspace(workspace);
    res.json({ success: true, sandboxId, bootupType: "CLEAN", isUpToDate: true });
  } catch (error: any) {
    console.error("[workspace:restart]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/workspace/:projectId/concurrency — active runtime slots per user
router.get("/:projectId/concurrency", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const { countActiveSandboxes } = await import("@dai/db");
    const activeCount = await countActiveSandboxes(user.userId);
    res.json({
      activeCount,
      maxAllowed: MAX_ACTIVE_RUNTIME_PROJECTS,
      canProceed: activeCount < MAX_ACTIVE_RUNTIME_PROJECTS,
    });
  } catch (error: any) {
    console.error("[workspace:concurrency]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

export default router;
