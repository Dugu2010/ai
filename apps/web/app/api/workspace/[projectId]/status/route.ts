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

    const vm = await client.getVM(project.vmId);
    if (!vm) {
      return NextResponse.json({ error: "VM not found" }, { status: 404 });
    }

    const status = {
      state: vm.state,
      vmId: vm.vmId,
      previewUrl: project.previewUrl,
      devServerRunning: project.devServerRunning,
      devServerPort: project.previewPort,
    };

    return NextResponse.json(status);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
