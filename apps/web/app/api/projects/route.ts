import { NextRequest, NextResponse } from "next/server";
import { pool, listProjects, createProject } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { FreestyleClient } from "@dai/freestyle";

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

export async function POST(request: NextRequest) {
  try {
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { slug, name, description } = body;

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

    const apiKey = getEnv("FREESTYLE_API_KEY");
    const timeout = parseInt(getEnv("DAI_IDLE_TIMEOUT_SECONDS") || "30", 10);
    const client = new FreestyleClient(apiKey);

    const vm = await client.createVM(`dai-${slug}`, timeout);

    const project = await createProject(user.userId, { slug, name, description });

    const vmUpdate = await pool.query(
      "UPDATE projects SET vm_id = $1, vm_slug = $2, status = 'ready' WHERE id = $3 RETURNING *",
      [vm.vmId, vm.slug, project.id]
    );

    const updatedProject = vmUpdate.rows[0];
    return NextResponse.json(updatedProject as any);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
