import { NextRequest, NextResponse } from "next/server";
import { listMessages, addMessage } from "@dai/db";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const { conversationId } = await params;
    const messages = await listMessages(conversationId);
    return NextResponse.json(messages as any);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const { conversationId } = await params;
    const body = await request.json();
    const { role, content, toolCalls, toolResults, usage } = body;

    if (!role || content === undefined) {
      return NextResponse.json({ error: "role and content required" }, { status: 400 });
    }

    const message = await addMessage(conversationId, {
      role,
      content,
      toolCalls,
      toolResults,
      usage,
    });

    return NextResponse.json(message as any);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
