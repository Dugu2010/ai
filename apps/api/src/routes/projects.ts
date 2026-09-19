import { Router, Request, Response } from "express";
import { pool, listProjects, createProject, getProjectByUser, deleteProject } from "@dai/db";
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

    const existing = await pool.query(
      "SELECT COUNT(*)::int AS count FROM projects WHERE slug = $1 AND user_id = $2",
      [slug, user.userId]
    );
    if ((existing.rows[0] as any)?.count > 0) {
      res.status(409).json({ error: "You already have a project with this slug" });
      return;
    }

    const project = await createProject(user.userId, { slug, name, description });

    // Provision the VM asynchronously but await so status is accurate on response.
    // If Freestyle is not configured, the project is still created in 'provisioning'.
    try {
      const client = freestyle();
      const vm = await client.createVM(`dai-${slug}`, IDLE_TIMEOUT_SECONDS());
      await pool.query(
        "UPDATE projects SET vm_id = $1, vm_slug = $2, status = 'ready', updated_at = now() WHERE id = $3",
        [vm.vmId, vm.slug, project.id]
      );
      res.status(201).json({ ...project, vmId: vm.vmId, vmSlug: vm.slug, status: "ready" });
    } catch (vmError: any) {
      console.error("[projects:POST] VM provisioning failed:", vmError.message);
      await pool.query(
        "UPDATE projects SET last_error = $1, updated_at = now() WHERE id = $2",
        [vmError.message, project.id]
      );
      res.status(201).json({ ...project, status: "provisioning", lastError: vmError.message });
    }
  } catch (error: any) {
    console.error("[projects:POST]", error.message);
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
    if (project.vmId) {
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
