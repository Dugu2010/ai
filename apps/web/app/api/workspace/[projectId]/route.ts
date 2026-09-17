import { NextRequest, NextResponse } from "next/server";
import { getProjectByUser } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { requireCsrf, generateCsrfToken } from "@/lib/csrf";
import { FreestyleClient } from "@dai/freestyle";
import { validatePath } from "@/lib/path-validation";
import { MAX_REQUEST_BODY_SIZE } from "@/lib/size-limits";

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

     const validation = validatePath(path);
     if (!validation.valid || !validation.normalized) {
       return NextResponse.json({ error: "Invalid path" }, { status: 403 });
     }

     const entries = await client.readDir(validation.normalized);
    return NextResponse.json(entries);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

const _workspaceAction = async (
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) => {
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

    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      return NextResponse.json({ error: "Request body exceeds maximum size" }, { status: 413 });
    }

    const body = await request.json();
    const { action, path, content, newPath } = body;

    if (!path) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const pathValidation = validatePath(path);
    if (!pathValidation.valid) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    if (newPath) {
      const newPathValidation = validatePath(newPath);
      if (!newPathValidation.valid || !newPathValidation.normalized) {
        return NextResponse.json({ error: "Invalid new path" }, { status: 400 });
      }
    }

    if (action === "write" || action === "create") {
      if (!pathValidation.normalized) {
        return NextResponse.json({ error: "Invalid path" }, { status: 400 });
      }
      await client.writeTextFile(pathValidation.normalized, content || "");
    } else if (action === "delete") {
      if (!pathValidation.normalized) {
        return NextResponse.json({ error: "Invalid path" }, { status: 400 });
      }
      await client.remove(pathValidation.normalized);
    } else if (action === "rename" || action === "move") {
      if (!pathValidation.normalized || !newPath) {
        return NextResponse.json({ error: "Invalid path or new path" }, { status: 400 });
      }
      await client.rename(pathValidation.normalized, newPath);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const POST = requireCsrf(_workspaceAction);
