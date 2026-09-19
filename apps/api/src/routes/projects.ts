import { Router, Request, Response } from "express";
import { listProjects, createProject, getProjectByUser, updateProject, deleteProject } from "@dai/db";
import { requireAuth, getAuthUser } from "../lib/auth.js";
import { FREESTYLE_API_KEY, IDLE_TIMEOUT_SECONDS } from "../lib/env.js";
import { FreestyleClient } from "@dai/freestyle";
import { MAX_REQUEST_BODY_SIZE } from "../lib/validation.js";

const router = Router();
router.use(requireAuth);

function freestyle(): FreestyleClient {
  const apiKey = FREESTYLE_API_KEY();
  if (!apiKey) {
    throw new Error("FREESTYLE_API_KEY is not configured on the backend");
  }
  return new FreestyleClient(apiKey);
}

/** VM slugs are unique per Freestyle account — suffix the DB id so retries never collide. */
function vmSlugFor(slug: string, projectId: string, attempt = 0): string {
  const short = projectId.replace(/-/g, "").slice(0, 8);
  const suffix = attempt > 0 ? `-${attempt}` : "";
  return `dai-${slug}-${short}${suffix}`.slice(0, 63);
}

/**
 * Provision a VM for a project and persist its identity.
 * Shared by POST (first provision) and POST /:id/reprovision (retry).
 */
async function provisionVM(project: { id: string; slug: string; name: string }, attempt = 0) {
  const client = freestyle();
  const slug = vmSlugFor(project.slug, project.id, attempt);
  // Dev server port 3000 published as https://<slug>.style.dev at create time.
  const vm = await client.createVM(slug, {
    idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS(),
    devPort: 3000,
  });
  const previewUrl = vm.domain ? `https://${vm.domain}` : null;

  const updated = await updateProject(project.id, {
    vmId: vm.vmId,
    vmSlug: vm.slug ?? slug,
    status: "ready",
    previewDomain: vm.domain,
    previewUrl,
    lastError: null,
  });
  return { updated, vm };
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

    // Provision the VM inline so the row's status is accurate on response.
    // If Freestyle is not configured or fails, the project stays 'provisioning'
    // with lastError set, and POST /:id/reprovision can retry later.
    if (!FREESTYLE_API_KEY()) {
      await updateProject(project.id, {
        lastError: "FREESTYLE_API_KEY not configured on backend",
      });
      res.status(201).json({ ...project, status: "provisioning", lastError: "FREESTYLE_API_KEY not configured on backend" });
      return;
    }

    try {
      const { updated, vm } = await provisionVM(project);
      res.status(201).json({ ...updated, vmId: vm.vmId });
    } catch (vmError: any) {
      console.error("[projects:POST] VM provisioning failed:", vmError.message);
      await updateProject(project.id, { lastError: vmError.message });
      res.status(201).json({ ...project, status: "provisioning", lastError: vmError.message });
    }
  } catch (error: any) {
    console.error("[projects:POST]", error.message);
    const status = error.code === "23505" ? 409 : 500;
    res.status(status).json({ error: error.code === "23505" ? "You already have a project with this slug" : error.message });
  }
});

// Retry provisioning for a project stuck in 'provisioning' or 'error'.
router.post("/:id/reprovision", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!FREESTYLE_API_KEY()) {
      res.status(503).json({ error: "FREESTYLE_API_KEY is not configured on the backend" });
      return;
    }

    // Clean up a half-created VM from a failed attempt, if any.
    if (project.vmId) {
      await freestyle().deleteVM(project.vmId);
    }

    const attemptMatch = /\-(\d+)$/.exec(project.vmSlug || "");
    const attempt = attemptMatch ? parseInt(attemptMatch[1]!, 10) + 1 : 0;
    const { updated } = await provisionVM(project, attempt);
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

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const project = await getProjectByUser(req.params.id!, user.userId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.vmId && FREESTYLE_API_KEY()) {
      try {
        await freestyle().deleteVM(project.vmId);
      } catch (vmError: any) {
        console.warn("[projects:DELETE] VM deletion failed:", vmError.message);
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
