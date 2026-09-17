import { NextRequest, NextResponse } from "next/server";
import { resetRateLimit } from "../../../../lib/rate-limit";
import { requireCsrf } from "../../../../lib/csrf";

const _logout = async (request: NextRequest) => {
  try {
    resetRateLimit(request);
    const response = NextResponse.json({ success: true });
    response.headers.set("Set-Cookie", "auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return response;
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const POST = requireCsrf(_logout);
