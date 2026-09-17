import { NextRequest, NextResponse } from "next/server";
import { pool, listProjects, createProject, getProjectByUser } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { requireCsrf, generateCsrfToken } from "@/lib/csrf";
import { FreestyleClient } from "@dai/freestyle";
import { MAX_REQUEST_BODY_SIZE } from "@/lib/size-limits";

// In-memory tracking of in-progress project creation requests by slug
//
// Limitations:
// - Only works within a single server instance
// - If you run multiple instances (e.g., in a cluster), you'll need a distributed
//   lock mechanism (e.g., Redis-based) to coordinate deduplication across instances
// - State is lost on server restart
//
const pendingRequests: Map<string, Promise<string>> = new Map();

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

export async function GET(request: NextRequest) {
  try {
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const projects = await listProjects(user.userId);
    return NextResponse.json(projects as any);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

const _createProject = async (request: NextRequest) => {
  const body = await request.json();
  const { slug, name, description } = body;

  try {
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      return NextResponse.json({ error: "Request body exceeds maximum size" }, { status: 413 });
    }

    if (!slug || !name) {
      return NextResponse.json({ error: "slug and name required" }, { status: 400 });
    }

    const existingCount = await pool.query(
      "SELECT COUNT(*) FROM projects WHERE slug = $1 AND user_id = $2",
      [slug, user.userId]
    );
    if (parseInt(existingCount.rows[0].count) > 0) {
      return NextResponse.json({ error: "Project with slug exists" }, { status: 409 });
    }

    // Check if there's already an in-progress request for this slug
    const existingPromise = pendingRequests.get(slug);
    if (existingPromise) {
      try {
        // Wait for the existing request to complete
        const vmId = await existingPromise;
        // Retrieve the project that was created by the existing request
        const project = await getProjectByUser(vmId.split("-").pop() || "", user.userId);
        if (project) {
          return NextResponse.json(project as any);
        }
        // If we can't find the project, fall through to create it
      } catch (error) {
        // If the existing request failed, clean up and proceed
        pendingRequests.delete(slug);
      }
    }

    const apiKey = getEnv("FREESTYLE_API_KEY");
    const timeout = parseInt(getEnv("DAI_IDLE_TIMEOUT_SECONDS") || "30", 10);
    const client = new FreestyleClient(apiKey);

    const vm = await client.createVM(`dai-${slug}`, timeout);

    const project = await createProject(user.userId, { slug, name, description });

    // Track the creation promise in-memory for deduplication
    const creationPromise = (async () => {
      try {
        const vmUpdate = await pool.query(
          "UPDATE projects SET vm_id = $1, vm_slug = $2, status = 'ready' WHERE id = $3 RETURNING *",
          [vm.vmId, vm.slug, project.id]
        );
        return vmUpdate.rows[0].vm_id;
      } finally {
        // Clean up the pending request when done
        pendingRequests.delete(slug);
      }
    })();
    pendingRequests.set(slug, creationPromise);

    const updatedProject = project;
    return NextResponse.json(updatedProject as any);
  } catch (error: any) {
    // Clean up pending request on error
    pendingRequests.delete(slug);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const POST = requireCsrf(_createProject);
