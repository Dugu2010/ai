import { Router, Request, Response } from "express";
import { getProjectByUser } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { FREESTYLE_API_KEY } from "../lib/env.js";
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
    throw new Error("FREESTYLE_API_KEY is not configured on the backend");
  }
  return new FreestyleClient(apiKey);
}

/** Load the project for this user, verify it has a VM, and return a ref'd client. */
async function vmForProject(req: Request, projectId: string): Promise<{ client: FreestyleClient; project: any } | null> {
  const user = getAuthUser(req);
  const project = await getProjectByUser(projectId, user.userId);
  if (!project) return null;
  if (!project.vmId) return { client: freestyle(), project }; // routes decide how to respond
  const client = freestyle();
  await client.refVM(project.vmId);
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
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
    const effectiveTimeout = Math.min(timeoutMs || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
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
    res.status(500).json({ error: error.message });
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
      res.json({ state: "provisioning", vmId: null, previewUrl: null, devServerRunning: false });
      return;
    }
    const vm = await ctx.client.getVM(ctx.project.vmId);
    res.json({
      state: vm?.state ?? "unknown",
      vmId: ctx.project.vmId,
      previewUrl: ctx.project.previewUrl,
      devServerRunning: ctx.project.devServerRunning,
      devServerPort: ctx.project.previewPort,
    });
  } catch (error: any) {
    console.error("[workspace:status]", error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/workspace/:projectId/preview — { command, port } start dev server + preview URL
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
    if (!command || !port) {
      res.status(400).json({ error: "command and port required" });
      return;
    }
    await ctx.client.startDevServer("/workspace", command, port);
    const domainSuffix = process.env.DAI_PREVIEW_DOMAIN_SUFFIX || "style.dev";
    const url = await ctx.client.getPreviewUrl(port, domainSuffix);
    const { updateProject } = await import("@dai/db");
    await updateProject(ctx.project.id, {
      previewPort: port,
      previewUrl: url,
      devServerRunning: true,
      status: "ready",
    });
    res.json({ url, port });
  } catch (error: any) {
    console.error("[workspace:preview]", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
