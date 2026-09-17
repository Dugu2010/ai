import { NextRequest, NextResponse } from "next/server";
import { getUserSettings, upsertUserSettings as updateUserSettings } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString("base64");
}

function base64Decode(str: string): string {
  return Buffer.from(str, "base64").toString("utf8");
}

export async function GET(request: NextRequest) {
  try {
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const settings = await getUserSettings(user.userId);
    if (!settings) {
      return NextResponse.json({
        nimModel: "deepseek-ai/deepseek-r7",
        nimBaseUrl: getEnv("NIM_BASE_URL") || "https://integrate.api.nvidia.com/v1",
      });
    }

    const { nimModel, nimBaseURL: nimBaseURLStored } = settings;
    const nimBaseUrl = nimBaseURLStored || getEnv("NIM_BASE_URL");

    return NextResponse.json({
      nimModel,
      nimBaseUrl,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { nimModel, nimBaseUrl, apiKey } = body;

    const nimKey = process.env.DAI_API_KEY_ENCRYPTION_KEY;
    let apiKeyEnc: string | null = null;
    if (apiKey && nimKey) {
      apiKeyEnc = base64Encode(apiKey);
    }

    await updateUserSettings(user.userId, {
      nimModel: nimModel || "deepseek-ai/deepseek-r7",
      nimBaseURL: nimBaseUrl || getEnv("NIM_BASE_URL"),
      nimApiKeyEnc: apiKeyEnc,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
