import { NextRequest, NextResponse } from "next/server";
import { getProjectByUser } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { FreestyleClient } from "@dai/freestyle";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
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
    const { command, cwd, timeoutMs } = body;

    if (!command) {
      return NextResponse.json({ error: "command required" }, { status: 400 });
    }

    if (cwd && !cwd.startsWith("/workspace")) {
      return NextResponse.json({ error: "cwd must be under /workspace" }, { status: 400 });
    }

    const safeCwd = cwd || "/workspace";

    const result = await client.exec(command, {
      cwd: safeCwd,
      timeoutMs: timeoutMs || 300000,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
