import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { JWT_EXPIRATION_SECONDS, JWT_ISSUER, JWT_SECRET } from "./env.js";

export interface AuthUser {
  userId: string;
  email: string;
}

interface JWTPayload {
  userId: string;
  email: string;
  exp: number;
  iss: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/_/g, "_");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function signJwt(payload: { userId: string; email: string }): string {
  const secret = JWT_SECRET();
  if (!secret) throw new Error("JWT_SECRET environment variable not set");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body: JWTPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + JWT_EXPIRATION_SECONDS(),
    iss: JWT_ISSUER(),
  };
  const payloadB64 = b64url(JSON.stringify(body));
  const signature = b64url(
    crypto.createHmac("sha256", secret).update(`${header}.${payloadB64}`).digest("base64")
  );
  return `${header}.${payloadB64}.${signature}`;
}

export function verifyJwt(token: string): AuthUser | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) return null;

    const secret = JWT_SECRET();
    if (!secret) return null;

    const header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as { alg?: string };
    if (header.alg !== "HS256") return null;

    const expected = b64url(
      crypto.createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64")
    );
    if (!constantTimeEqual(expected, signatureB64)) return null;

    const payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as JWTPayload;
    if (payload.iss !== JWT_ISSUER()) return null;
    if (payload.exp !== undefined && Date.now() / 1000 >= payload.exp) return null;
    if (typeof payload.userId !== "string" || typeof payload.email !== "string") return null;
    return { userId: payload.userId, email: payload.email };
  } catch {
    return null;
  }
}

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  // Cookie fallback (same-origin browser requests)
  const cookies = req.headers.cookie;
  if (cookies) {
    for (const part of cookies.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === "auth_token" || k === "auth-token") return rest.join("=");
    }
  }
  return null;
}

/** Express middleware: attaches req.user or responds 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  const user = token ? verifyJwt(token) : null;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as Request & { user?: AuthUser }).user = user;
  next();
}

export function getAuthUser(req: Request): AuthUser {
  return (req as Request & { user?: AuthUser }).user!;
}
