import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const response = NextResponse.json({ success: true });
    response.headers.set("Set-Cookie", `auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return response;
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
