import { Router, Request, Response } from "express";
import { listProjects, createProject, getProjectByUser, updateProject, deleteProject } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { CODESANDBOX_API_KEY, IDLE_TIMEOUT_SECONDS } from "../lib/env.js";
import { CodeSandboxClient } from "@dai/codesandbox";
import { MAX_REQUEST_BODY_SIZE } from "../lib/validation.js";
import { requestSandboxSlot } from "../lib/sandbox-queue.js";

const router = Router();
router.use(requireAuth);

function codesandbox(): CodeSandboxClient {
  const apiKey = CODESANDBOX_API_KEY();
  if (!apiKey) {
    throw new Error("CODESANDBOX_API_KEY is not configured on the backend");
  }
  return new CodeSandboxClient(apiKey);
}

function sandboxSlugFor(slug: string, projectId: string, attempt = 0): string {
  const short = projectId.replace(/-/g, "").slice(0, 8);
  const suffix = attempt > 0 ? `-${attempt}` : "";
  return `dai-${slug}-${short}${suffix}`.slice(0, 63);
}

// Template built via `npx @codesandbox/sdk build ./sandbox --ports 3000`
// Rebuild this template when the base project changes.
const DAI_TEMPLATE_ID = "k8dsq1";

export async function provisionSandbox(project: { id: string; slug: string; name: string }, attempt = 0) {
  const client = codesandbox();
  const slug = sandboxSlugFor(project.slug, project.id, attempt);
  const sandbox = await client.createSandbox(DAI_TEMPLATE_ID, {
    hibernationTimeoutSeconds: IDLE_TIMEOUT_SECONDS(),
    privacy: "public",
  });
  const previewUrl = sandbox.editorUrl;

  const updated = await updateProject(project.id, {
    sandboxId: sandbox.sandboxId,
    sandboxSlug: slug,
    status: "ready",
    previewUrl,
    lastError: null,
  });
  return { updated, sandbox };
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

    if (!CODESANDBOX_API_KEY()) {
      await updateProject(project.id, {
        lastError: "CODESANDBOX_API_KEY not configured on backend",
      });
      res.status(201).json({ ...project, status: "provisioning", lastError: "CODESANDBOX_API_KEY not configured on backend" });
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
      res.status(201).json({ ...project, status: "provisioning", lastError: sandboxError.message });
    }
  } catch (error: any) {
    console.error("[projects:POST]", error.message);
    const status = error.code === "23505" ? 409 : 500;
    res.status(status).json({ error: error.code === "23505" ? "You already have a project with this slug" : error.message });
  }
});

router.post("/:id/reprovision", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!CODESANDBOX_API_KEY()) {
      res.status(503).json({ error: "CODESANDBOX_API_KEY is not configured on the backend" });
      return;
    }

    if (project.sandboxId) {
      await codesandbox().deleteSandbox(project.sandboxId);
    }

    const attemptMatch = /\-(\d+)$/.exec(project.sandboxSlug || "");
    const attempt = attemptMatch ? parseInt(attemptMatch[1]!, 10) + 1 : 0;
    const { updated } = await provisionSandbox(project, attempt);
    res.json(updated);
  } catch (error: any) {
    console.error("[projects:reprovision]", error.message);
    res.status(500).json({ error: error.message });
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

router.post("/:id/fork", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!CODESANDBOX_API_KEY()) {
      res.status(503).json({ error: "CODESANDBOX_API_KEY is not configured on the backend" });
      return;
    }

    if (!project.sandboxId) {
      res.status(409).json({ error: "Project sandbox is not provisioned yet" });
      return;
    }

    // Fork safety (Item 8): CodeSandboxClient.forkSandbox resumes + hibernates
    // the source sandbox first, then forks with the documented
    // sdk.sandboxes.create({ id }) form. For a hibernated parent the fork takes
    // 1-3s; forking a RUNNING parent would be a limited, slow "Live Fork".
    // Ref: https://codesandbox.stream/docs/sdk/create + /resume
    const client = codesandbox();
    const forkResult = await client.forkSandbox(project.sandboxId);

    const newProject = await createProject(user.userId, {
      slug: `${project.slug}-fork`,
      name: `${project.name} (Fork)`,
      description: project.description ?? undefined,
    });

    await updateProject(newProject.id, {
      sandboxId: forkResult.sandboxId,
      status: "ready",
      previewUrl: forkResult.editorUrl,
    });

    res.json({ ...newProject, previewUrl: forkResult.editorUrl, sandboxId: forkResult.sandboxId });
  } catch (error: any) {
    console.error("[projects:fork]", error.message);
    res.status(500).json({ error: error.message });
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
    if (project.sandboxId && CODESANDBOX_API_KEY()) {
      try {
        await codesandbox().deleteSandbox(project.sandboxId);
      } catch (sandboxError: any) {
        console.warn("[projects:DELETE] Sandbox deletion failed:", sandboxError.message);
      }
    }
    await deleteProject(project.id);
    res.json({ success: true });
  } catch (error: any) {
    console.error("[projects:DELETE]", error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;