import { Router, Request, Response } from "express";
import { getProjectByUser, updateProject } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { FREESTYLE_API_KEY, PREVIEW_DOMAIN_SUFFIX } from "../lib/env.js";
import { FreestyleClient } from "@dai/freestyle";
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

function freestyle(): FreestyleClient {
  const apiKey = FREESTYLE_API_KEY();
  if (!apiKey) {
    throw Object.assign(new Error("FREESTYLE_API_KEY is not configured on the backend"), { statusCode: 503 });
  }
  return new FreestyleClient(apiKey);
}

const DEV_SERVER_SESSION = "dev-server";
const DEV_PORT = 3000;

/** Load the project for this user and return a client ref'd to its VM. */
async function vmForProject(req: Request, projectId: string): Promise<{ client: FreestyleClient; project: any } | null> {
  const user = getAuthUser(req);
  const project = await getProjectByUser(projectId, user.userId);
  if (!project) return null;
  if (!project.vmId) return { client: freestyle(), project }; // routes decide how to respond
  const client = freestyle();
  client.refVM(project.vmId);
  return { client, project };
}

// GET /api/workspace/:projectId?path=/workspace — list directory
router.get("/:projectId", async (req: Request, res: Response) => {
  try {
    const ctx = await vmForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.vmId) {
      res.status(409).json({ error: "Project VM is not provisioned yet" });
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
    const ctx = await vmForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.vmId) {
      res.status(409).json({ error: "Project VM is not provisioned yet" });
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
    const ctx = await vmForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.vmId) {
      res.status(409).json({ error: "Project VM is not provisioned yet" });
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
    const ctx = await vmForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.vmId) {
      res.status(409).json({ error: "Project VM is not provisioned yet" });
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

// GET /api/workspace/:projectId/status — VM state + dev server info
router.get("/:projectId/status", async (req: Request, res: Response) => {
  try {
    const ctx = await vmForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.vmId) {
      res.json({ state: "provisioning", vmId: null, previewUrl: ctx.project.previewUrl, devServerRunning: false });
      return;
    }
    const vm = await ctx.client.getVM(ctx.project.vmId);
    const devRunning = vm?.state === "running" ? await ctx.client.devServerRunning(DEV_SERVER_SESSION) : false;
    res.json({
      state: vm?.state ?? "unknown",
      vmId: ctx.project.vmId,
      previewUrl: ctx.project.previewUrl,
      devServerRunning: devRunning,
      devServerPort: ctx.project.previewPort,
      lastError: ctx.project.lastError,
    });
  } catch (error: any) {
    console.error("[workspace:status]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/preview — start dev server, wait for port, return public URL
router.post("/:projectId/preview", async (req: Request, res: Response) => {
  try {
    const ctx = await vmForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.vmId) {
      res.status(409).json({ error: "Project VM is not provisioned yet" });
      return;
    }
    const { command, port } = req.body ?? {};
    const devPort = Number(port) || DEV_PORT;
    const devCommand = typeof command === "string" && command.trim() ? command.trim() : "npm run dev";
    if (devPort < 1 || devPort > 65535) {
      res.status(400).json({ error: "port must be 1-65535" });
      return;
    }

    const { sessionId, restarted } = await ctx.client.startDevServer("/workspace", devCommand, devPort, {
      sessionSlug: DEV_SERVER_SESSION,
      restart: ctx.project.devServerRunning === true,
    });

    // Wait until something actually answers on the port (best effort; don't
    // fail the request if the probe can't confirm — the server may still come
    // up after we respond).
    const portUp = await ctx.client.waitForPort(devPort, 40_000);

    // Public URL: the *.style.dev ingress domain minted at VM create.
    const url =
      ctx.project.previewUrl ||
      (ctx.project.previewDomain ? `https://${ctx.project.previewDomain}` : null) ||
      (await ctx.client.getPreviewUrl(devPort, PREVIEW_DOMAIN_SUFFIX()));

    await updateProject(ctx.project.id, {
      previewPort: devPort,
      previewUrl: url,
      devServerRunning: true,
      status: "ready",
      lastError: null,
    });

    res.json({
      url,
      port: devPort,
      sessionId,
      restarted,
      portUp,
      note: portUp ? undefined : "Dev server is starting; the URL may take a few more seconds.",
    });
  } catch (error: any) {
    console.error("[workspace:preview]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/preview/stop
router.post("/:projectId/preview/stop", async (req: Request, res: Response) => {
  try {
    const ctx = await vmForProject(req, req.params.projectId!);
    if (!ctx) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!ctx.project.vmId) {
      res.status(409).json({ error: "Project VM is not provisioned yet" });
      return;
    }
    await ctx.client.stopDevServer(DEV_SERVER_SESSION);
    await updateProject(ctx.project.id, { devServerRunning: false });
    res.json({ success: true });
  } catch (error: any) {
    console.error("[workspace:preview:stop]", error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

export default router;
