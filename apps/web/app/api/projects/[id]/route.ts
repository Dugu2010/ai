import { NextRequest, NextResponse } from "next/server";
import { pool, getProjectByUser } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { requireCsrf, generateCsrfToken } from "@/lib/csrf";
import { FreestyleClient } from "@dai/freestyle";
import { MAX_REQUEST_BODY_SIZE } from "@/lib/size-limits";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const project = await getProjectByUser(id, user.userId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    return NextResponse.json(project as any);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

const _deleteProject = async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  try {
    const { id } = await params;
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const project = await getProjectByUser(id, user.userId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    if (project.vmId) {
      const apiKey = getEnv("FREESTYLE_API_KEY");
      const client = new FreestyleClient(apiKey);
      await client.deleteVM(project.vmId);
    }

    await pool.query("DELETE FROM projects WHERE id = $1 AND user_id = $2", [id, user.userId]);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const DELETE = requireCsrf(_deleteProject);
