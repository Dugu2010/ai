import { NextRequest, NextResponse } from "next/server";
import { createUser, getUserByEmailWithPassword } from "@dai/db";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { checkRateLimit, recordFailedAttempt, resetRateLimit } from "../../../../lib/rate-limit";
import { MAX_REQUEST_BODY_SIZE } from "../../../../lib/size-limits";

function simpleJwt(payload: { userId: string; email: string; exp: number; iss: string }): string {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) throw new Error("JWT_SECRET environment variable not set");
  const base64UrlEncode = (str: string) => 
    Buffer.from(str).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/_/g, "_");
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload64 = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(
    crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload64}`).digest("base64")
  );
  return `${header}.${payload64}.${signature}`;
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = checkRateLimit(request);
    if (rateLimit.limited) {
      return NextResponse.json(
        { error: "Too many failed attempts. Please try again later.", retryAfter: rateLimit.retryAfter },
        { status: 429 }
      );
    }

    const { email, password, name } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    const existing = await getUserByEmailWithPassword(email);
    if (!existing) {
      recordFailedAttempt(request);
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const valid = await bcrypt.compare(password, existing.password_hash);
    if (!valid) {
      recordFailedAttempt(request);
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      return NextResponse.json({ error: "Request body exceeds maximum size" }, { status: 413 });
    }

    resetRateLimit(request);
    const now = Math.floor(Date.now() / 1000);
    const token = simpleJwt({ userId: existing.id, email: existing.email, exp: now + 604800, iss: "dai-auth" });

    const response = NextResponse.json({ userId: existing.id, email: existing.email, token });
    response.headers.set("Set-Cookie", `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${604800}`);
    return response;
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
