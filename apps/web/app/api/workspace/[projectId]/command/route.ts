import { NextRequest, NextResponse } from "next/server";
import { getProjectByUser } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";
import { requireCsrf, generateCsrfToken } from "@/lib/csrf";
import { FreestyleClient } from "@dai/freestyle";
import { validateCommandOptions, MAX_TIMEOUT_MS } from "@/lib/command-validation";
import { validatePath } from "@/lib/path-validation";
import { MAX_REQUEST_BODY_SIZE, MAX_OUTPUT_SIZE } from "@/lib/size-limits";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

const _execCommand = async (
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
    const { command, cwd, timeoutMs } = body;

    const validation = validateCommandOptions({ command, cwd, timeoutMs });
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

     const cwdValidation = validatePath(cwd || "/workspace");
     if (!cwdValidation.valid || !cwdValidation.normalized) {
       return NextResponse.json({ error: cwdValidation.error || "Invalid working directory" }, { status: 400 });
     }

    const effectiveTimeout = Math.min(timeoutMs || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const result = await client.exec(command, {
      cwd: cwdValidation.normalized,
      timeoutMs: effectiveTimeout,
    });

    const outputStr = JSON.stringify(result);
    if (outputStr.length > MAX_OUTPUT_SIZE) {
      return NextResponse.json({ error: "Output exceeds maximum size" }, { status: 413 });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const POST = requireCsrf(_execCommand);
