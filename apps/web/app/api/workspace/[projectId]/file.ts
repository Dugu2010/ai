import { NextRequest, NextResponse } from "next/server";
import { getProjectByUser } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { FreestyleClient } from "@dai/freestyle";
import { validatePath } from "@/lib/path-validation";
import { MAX_FILE_READ_SIZE } from "@/lib/size-limits";

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
       return NextResponse.json({ error: validation.error || "Access denied" }, { status: 403 });
     }

     const content = await client.readFile(validation.normalized);
    if (content === null) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (content.length > MAX_FILE_READ_SIZE) {
      return NextResponse.json({ error: "File exceeds maximum read size" }, { status: 400 });
    }

    return new Response(content, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
