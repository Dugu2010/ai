import { NextRequest, NextResponse } from "next/server";
import { getProjectByUser } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { FreestyleClient } from "@dai/freestyle";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const project = await getProjectByUser(projectId, user.userId);
    if (!project || !project.vmId) {
      return NextResponse.json({ error: "Project not found or no VM" }, { status: 404 });
    }

    const apiKey = getEnv("FREESTYLE_API_KEY");
    const client = new FreestyleClient(apiKey);
    await client.refVM(project.vmId);

    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path") || "/workspace";

    if (path.startsWith("/workspace")) {
      const entries = await client.readDir(path);
      return NextResponse.json(entries);
    }

    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const project = await getProjectByUser(projectId, user.userId);
    if (!project || !project.vmId) {
      return NextResponse.json({ error: "Project not found or no VM" }, { status: 404 });
    }

    const apiKey = getEnv("FREESTYLE_API_KEY");
    const client = new FreestyleClient(apiKey);
    await client.refVM(project.vmId);

    const body = await request.json();
    const { action, path, content, newPath } = body;

    if (!path || !path.startsWith("/workspace")) {
      return NextResponse.json({ error: "Path must be under /workspace" }, { status: 400 });
    }

    if (newPath && !newPath.startsWith("/workspace")) {
      return NextResponse.json({ error: "New path must be under /workspace" }, { status: 400 });
    }

    if (action === "write" || action === "create") {
      await client.writeTextFile(path, content || "");
    } else if (action === "delete") {
      await client.remove(path);
    } else if (action === "rename" || action === "move") {
      await client.rename(path, newPath!);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
