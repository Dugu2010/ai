import { NextRequest, NextResponse } from "next/server";
import { getActiveConversation, createConversation } from "@dai/db";
import { getUserFromRequest } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const conv = await getActiveConversation(id);
    return NextResponse.json(conv as any);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { title, model } = body;

    if (!title) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }

    const conv = await createConversation(id, { title, model: model || "deepseek-ai/deepseek-r7" });
    return NextResponse.json(conv as any);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
