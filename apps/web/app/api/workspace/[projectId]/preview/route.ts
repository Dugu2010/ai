import { NextRequest, NextResponse } from "next/server";
import { getProjectByUser, updateProject } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { requireCsrf, generateCsrfToken } from "@/lib/csrf";
import { FreestyleClient } from "@dai/freestyle";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

const _startPreview = async (
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

    const body = await request.json();
    const { command, port } = body;

    if (!command || !port) {
      return NextResponse.json({ error: "command and port required" }, { status: 400 });
    }

    await client.startDevServer("/workspace", command, port);

    const domainSuffix = getEnv("DAI_PREVIEW_DOMAIN_SUFFIX") || "style.dev";
    const url = await client.getPreviewUrl(port, domainSuffix);

    await updateProject(projectId, {
      previewPort: port,
      previewUrl: url,
      devServerRunning: true,
      status: "ready",
    });

    return NextResponse.json({ url, port });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const POST = requireCsrf(_startPreview);
