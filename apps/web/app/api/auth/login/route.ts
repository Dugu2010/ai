import { NextRequest, NextResponse } from "next/server";
import { createUser, getUserByEmail } from "@dai/db";
import bcrypt from "bcryptjs";
import crypto from "crypto";

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

function simpleJwt(payload: { userId: string; email: string }): string {
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
    const { email, password, name } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    const existing = await getUserByEmail(email);
    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      const hashed = await bcrypt.hash(password, 10);
      const user = await createUser(email, name || null, hashed);
      userId = user.id;
    }

    const token = simpleJwt({ userId, email });

    const response = NextResponse.json({ userId, email, token });
    response.headers.set("Set-Cookie", `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${604800}`);
    return response;
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
