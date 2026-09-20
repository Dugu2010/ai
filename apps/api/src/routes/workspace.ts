import { Router, Request, Response } from "express";
import { getProjectByUser, updateProject } from "@dai/db";
import type { Project } from "@dai/types";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { CODESANDBOX_API_KEY } from "../lib/env.js";
import { CodeSandboxClient } from "@dai/codesandbox";
import {
  validatePath,
  validateCommandOptions,
  MAX_REQUEST_BODY_SIZE,
  MAX_OUTPUT_SIZE,
  MAX_FILE_READ_SIZE,
  MAX_TIMEOUT_MS,
} from "../lib/validation.js";

const router = Router();
router.use(requireAuth);

function codesandbox(): CodeSandboxClient {
  const apiKey = CODESANDBOX_API_KEY();
  if (!apiKey) {
    throw Object.assign(new Error("CODESANDBOX_API_KEY is not configured on the backend"), { statusCode: 503 });
  }
  return new CodeSandboxClient(apiKey);
}

const DEV_PORT = 3000;
/** Signed preview URLs are valid for 1 hour (see createHostPreview / sdk.hosts.createToken). */
const HOST_TOKEN_TTL_HOURS = 1;

// Check if sandbox is archived (>7 days since last access)
function isArchived(lastAccessedAt: string | null): boolean {
  if (!lastAccessedAt) return false;
  const daysSinceAccess = (Date.now() - new Date(lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceAccess > 7;
}

/**
 * Bring the sandbox to a booted, ready state.
 *
 * Clean bootup handling per https://codesandbox.stream/docs/sdk/resume
 * ("Clean Bootups") and https://codesandbox.stream/docs/sdk/setup:
 * on a CLEAN boot the setup tasks run again, so we wait for every setup step
 * to finish BEFORE any agent command executes. In @codesandbox/sdk 2.4.2,
 * `client.setup.getSteps()` is synchronous and returns `Step[]`, each with
 * `step.waitUntilComplete()`; `client.setup.waitUntilComplete()` awaits all.
 */
async function ensureSandboxBooted(
  client: CodeSandboxClient,
  project: Project
): Promise<{
  booted: boolean;
  bootupType: "CLEAN" | "RESUME" | "RUNNING" | "FORK" | null;
  isUpToDate: boolean | null;
  archived: boolean;
}> {
  const archived = isArchived(project.lastAccessedAt);
  if (!project.sandboxId) {
    return { booted: false, bootupType: null, isUpToDate: null, archived };
  }
  // Explicit resume. This also reconnects the client and, when bootupType is
  // CLEAN, waits for all setup steps inside CodeSandboxClient.resumeSandbox().
  const result = await client.resumeSandbox(project.sandboxId);
  await updateProject(project.id, {
    lastAccessedAt: new Date().toISOString(),
    isHibernated: false,
    bootupType: result.bootupType,
    isUpToDate: result.isUpToDate,
  });
  return {
    booted: true,
    bootupType: result.bootupType,
    isUpToDate: result.isUpToDate,
    archived,
  };
}

/**
 * Preview proxy payload.
 *
 * Per https://codesandbox.stream/docs/sdk/resume: "Avoid automatic HTTP wakeup
 * — waking it up from a preview URL can create a blocking UX. Rather implement
 * a proxy through your server." So the browser never hits $SANDBOX_ID-$PORT.csb.app
 * directly while hibernated: it calls POST /preview/proxy, we explicitly resume
 * the sandbox, make sure the dev-server task is running, wait for the port, and
 * only then hand back a signed host URL (sdk.hosts.createToken/getUrl).
 */
async function previewProxy(
  req: Request,
  projectId: string,
  port: number
): Promise<{
  url: string | null;
  isHibernated: boolean;
  wasHibernated: boolean;
  isArchived: boolean;
  bootupType: "CLEAN" | "RESUME" | "RUNNING" | "FORK" | null;
  devServerRunning: boolean;
  warning?: string;
}> {
  const user = getAuthUser(req);
  const project = await getProjectByUser(projectId, user.userId);
  if (!project || !project.sandboxId) {
    return {
      url: null,
      isHibernated: false,
      wasHibernated: false,
      isArchived: false,
      bootupType: null,
      devServerRunning: false,
    };
  }

  const client = codesandbox();
  const archived = isArchived(project.lastAccessedAt);

  // 1) Explicit resume (handles CLEAN bootup setup waits too).
  const booted = await ensureSandboxBooted(client, project);

  // 2) Make sure the dev server task (defined in .codesandbox/tasks.json) runs.
  //    startDevServer reuses the task when it is already running and throws a
  //    clear error if the template defines no such task.
  let devServerRunning = project.devServerRunning;
  try {
    const { reused } = await client.startDevServer("/workspace", "npm run dev", port);
    devServerRunning = true;
    if (!reused) {
      await updateProject(project.id, { devServerRunning: true });
    }
  } catch (error: any) {
    console.warn(`[workspace:preview-proxy] dev task not started: ${error?.message ?? error}`);
  }

  // 3) Wait briefly for the port so the first iframe load does not fail.
  await client.waitForPort(port, 40_000);

  // 4) Signed host URL via the documented HostTokens API:
  //    createToken(sandboxId, { expiresAt: Date }): Promise<HostToken>
  //    getUrl(token, port): string
  //    (https://codesandbox.io/docs/sdk/sandbox-hosts). The signed URL sets a
  //    cookie in the browser so subsequent iframe requests authenticate.
  const preview = await client.createHostPreview(project.sandboxId, port, HOST_TOKEN_TTL_HOURS);

  return {
    url: preview.url,
    isHibernated: false,
    wasHibernated: project.isHibernated,
    isArchived: archived,
    bootupType: booted.bootupType,
    devServerRunning,
    warning: archived ? "This project is in cold storage. Opening may take up to a minute." : undefined,
  };
}

async function sandboxForProject(
  req: Request,
  projectId: string
): Promise<{
  client: CodeSandboxClient;
  project: Project;
  bootupType: "CLEAN" | "RESUME" | "RUNNING" | "FORK" | null;
} | null> {
  const user = getAuthUser(req);
  const project = await getProjectByUser(projectId, user.userId);
  if (!project) return null;
  const client = codesandbox();
  if (!project.sandboxId) {
    return { client, project, bootupType: null };
  }
  try {
    // Resume + (on CLEAN boots) wait for all setup steps before any command.
    const booted = await ensureSandboxBooted(client, project);
    return { client, project, bootupType: booted.bootupType };
  } catch (error: any) {
    // Boot failures must not brick the workspace endpoints; the individual
    // SDK calls in each route will surface the real error if the VM is down.
    console.warn(`[workspace] sandbox boot failed: ${error?.message ?? error}`);
    return { client, project, bootupType: null };
  }
}

// GET /api/workspace/:projectId?path=/workspace — list directory
router.get("/:projectId", async (req: Request, res: Response) => {
  try {
    const ctx = await sandboxForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.sandboxId) {
      res.status(409).json({ error: "Project sandbox is not provisioned yet" });
      return;
    }
    const path = (req.query.path as string) || "/workspace";
    const validation = validatePath(path);
    if (!validation.valid || !validation.normalized) {
      res.status(403).json({ error: validation.error || "Invalid path" });
      return;
    }
    const entries = await ctx.client.readDir(validation.normalized);
    res.json(entries);
  } catch (error: any) {
    console.error("[workspace:GET]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId — { action: write|create|delete|rename|move, path, content?, newPath? }
router.post("/:projectId", async (req: Request, res: Response) => {
  try {
    const ctx = await sandboxForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.sandboxId) {
      res.status(409).json({ error: "Project sandbox is not provisioned yet" });
      return;
    }
    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      res.status(413).json({ error: "Request body exceeds maximum size" });
      return;
    }
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
        await ctx.client.writeTextFile(pathValidation.normalized, typeof content === "string" ? content : "");
        break;
      }
      case "delete": {
        await ctx.client.remove(pathValidation.normalized);
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
        await ctx.client.rename(pathValidation.normalized, newPathValidation.normalized);
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
  }
});

// GET /api/workspace/:projectId/file?path=... — read file contents
router.get("/:projectId/file", async (req: Request, res: Response) => {
  try {
    const ctx = await sandboxForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.sandboxId) {
      res.status(409).json({ error: "Project sandbox is not provisioned yet" });
      return;
    }
    const path = (req.query.path as string) || "";
    const validation = validatePath(path);
    if (!validation.valid || !validation.normalized) {
      res.status(403).json({ error: validation.error || "Invalid path" });
      return;
    }
    const content = await ctx.client.readFile(validation.normalized);
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
  }
});

// POST /api/workspace/:projectId/command — { command, cwd?, timeoutMs? }
router.post("/:projectId/command", async (req: Request, res: Response) => {
  try {
    const ctx = await sandboxForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.sandboxId) {
      res.status(409).json({ error: "Project sandbox is not provisioned yet" });
      return;
    }
    const contentLength = req.headers["content-length"];
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      res.status(413).json({ error: "Request body exceeds maximum size" });
      return;
    }
    const { command, cwd, timeoutMs } = req.body ?? {};
    const validation = validateCommandOptions({ command, cwd, timeoutMs });
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const cwdValidation = validatePath(cwd || "/workspace");
    if (!cwdValidation.valid || !cwdValidation.normalized) {
      res.status(400).json({ error: cwdValidation.error || "Invalid working directory" });
      return;
    }
    const effectiveTimeout = Math.min(Number(timeoutMs) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const result = await ctx.client.exec(command, {
      cwd: cwdValidation.normalized,
      timeoutMs: effectiveTimeout,
    });
    if (JSON.stringify(result).length > MAX_OUTPUT_SIZE) {
      res.status(413).json({ error: "Output exceeds maximum size" });
      return;
    }
    res.json(result);
  } catch (error: any) {
    console.error("[workspace:command]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/workspace/:projectId/status — sandbox state WITHOUT waking it up.
// Uses sandboxes.get() (metadata only). Resume is deliberately NOT called here:
// per https://codesandbox.stream/docs/sdk/resume, waking should be an explicit,
// user-visible step (POST /preview/proxy), never a polling side effect.
router.get("/:projectId/status", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.projectId!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!project.sandboxId) {
      res.json({
        state: "provisioning",
        sandboxId: null,
        previewUrl: project.previewUrl,
        devServerRunning: false,
        isHibernated: project.isHibernated,
        isArchived: isArchived(project.lastAccessedAt),
        bootupType: project.bootupType,
        isUpToDate: project.isUpToDate,
      });
      return;
    }
    let info: unknown = null;
    try {
      info = await codesandbox().getSandboxInfo(project.sandboxId);
    } catch (error: any) {
      console.warn(`[workspace:status] sandbox lookup failed: ${error?.message ?? error}`);
    }
    res.json({
      state: info ? "running" : "unknown",
      sandboxId: project.sandboxId,
      previewUrl: project.previewUrl,
      devServerRunning: project.devServerRunning,
      devServerPort: project.previewPort,
      lastError: project.lastError,
      isHibernated: project.isHibernated,
      isArchived: isArchived(project.lastAccessedAt),
      bootupType: project.bootupType,
      isUpToDate: project.isUpToDate,
    });
  } catch (error: any) {
    console.error("[workspace:status]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/preview — start the dev server task, wait for
// the port, and return a preview URL.
router.post("/:projectId/preview", async (req: Request, res: Response) => {
  try {
    const ctx = await sandboxForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.sandboxId) {
      res.status(409).json({ error: "Project sandbox is not provisioned yet" });
      return;
    }
    const { command, port } = req.body ?? {};
    const devPort = Number(port) || DEV_PORT;
    const devCommand = typeof command === "string" && command.trim() ? command.trim() : "npm run dev";
    if (devPort < 1 || devPort > 65535) {
      res.status(400).json({ error: "port must be 1-65535" });
      return;
    }

    // Uses the Tasks system (client.tasks) under the hood — see
    // CodeSandboxClient.startDevServer. Never shells.run().
    const { taskId } = await ctx.client.startDevServer("/workspace", devCommand, devPort);
    const portUp = await ctx.client.waitForPort(devPort, 40_000);

    let previewUrl: string | null = ctx.project.previewUrl ?? null;
    if (!previewUrl && ctx.project.previewDomain) {
      previewUrl = `https://${ctx.project.previewDomain}`;
    }
    if (!previewUrl) {
      const target = await ctx.client.getPreviewUrl(devPort);
      previewUrl = target.url;
    }

    await updateProject(ctx.project.id, {
      previewPort: devPort,
      previewUrl,
      devServerRunning: true,
      status: "ready",
      lastError: null,
    });

    res.json({
      url: previewUrl,
      port: devPort,
      taskId,
      portUp,
      note: portUp ? undefined : "Dev server is starting; the URL may take a few more seconds.",
    });
  } catch (error: any) {
    console.error("[workspace:preview]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/preview/proxy — the Item 9 preview proxy.
// Explicitly resumes a hibernated sandbox (no automatic HTTP wakeup), ensures
// the dev task is running, waits for the port, then returns a signed URL from
// sdk.hosts.createToken()/getUrl(). The frontend shows its loading state while
// this request is in flight (1-3s regular resume, up to ~60s from cold storage).
router.post("/:projectId/preview/proxy", async (req: Request, res: Response) => {
  try {
    const result = await previewProxy(req, req.params.projectId!, DEV_PORT);
    res.json(result);
  } catch (error: any) {
    console.error("[workspace:preview-proxy]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/preview/stop
router.post("/:projectId/preview/stop", async (req: Request, res: Response) => {
  try {
    const ctx = await sandboxForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.sandboxId) {
      res.status(409).json({ error: "Project sandbox is not provisioned yet" });
      return;
    }
    await ctx.client.stopDevServer();
    await updateProject(ctx.project.id, { devServerRunning: false });
    res.json({ success: true });
  } catch (error: any) {
    console.error("[workspace:preview:stop]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/restart — restart the sandbox to update the
// VM agent. Sandboxes.restart() preserves project files and is the documented
// way to apply an agent update (Sandbox.isUpToDate: "Use 'restart' to update
// the agent" — https://codesandbox.stream/docs/sdk/resume).
router.post("/:projectId/restart", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.projectId!, user.userId);
    if (!project || !project.sandboxId) {
      res.status(404).json({ error: "Project not found or sandbox not provisioned" });
      return;
    }
    const client = codesandbox();
    const result = await client.restartSandbox(project.sandboxId);
    await updateProject(project.id, {
      lastAccessedAt: new Date().toISOString(),
      isHibernated: false,
      bootupType: result.bootupType,
      isUpToDate: result.isUpToDate,
    });
    res.json({ success: true, bootupType: result.bootupType, isUpToDate: result.isUpToDate });
  } catch (error: any) {
    console.error("[workspace:restart]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/workspace/:projectId/concurrency — check sandbox concurrency slot
router.get("/:projectId/concurrency", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const { countActiveSandboxes } = await import("@dai/db");
    const activeCount = await countActiveSandboxes(user.userId);
    const canProceed = activeCount < 10;

    res.json({
      activeCount,
      maxAllowed: 10,
      canProceed,
    });
  } catch (error: any) {
    console.error("[workspace:concurrency]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

export default router;
