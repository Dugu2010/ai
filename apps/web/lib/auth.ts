import { NextRequest } from "next/server";
import * as crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_ISSUER = process.env.JWT_ISSUER || "dai-app";
const JWT_EXPIRATION_SECONDS = parseInt(process.env.JWT_EXPIRATION_SECONDS || "3600", 10);

export interface AuthUser {
  userId: string;
  email: string;
}

/**
 * JWT implementation for authentication.
 *
 * Features:
 * - HS256 HMAC-SHA256 signature verification
 * - Constant-time signature comparison to prevent timing attacks
 * - Expiration (exp claim) validation
 * - Issuer (iss claim) validation
 * - Base64URL encoding support
 */

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract and verify user authentication from request cookie.
 */
export function getUserFromRequest(request: NextRequest): AuthUser | null {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return null;
  return jwtVerify(token);
}

interface JWTPayload {
  userId: string;
  email: string;
  exp?: number;
  iss?: string;
}

/**
 * Verify and decode a JWT token.
 * Validates signature, expiration, and issuer.
 */
function jwtVerify(token: string): AuthUser | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !JWT_SECRET) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) return null;

    const header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/"))) as { alg?: string };
    if (header.alg !== "HS256") return null;

    const expectedSignature = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    if (!constantTimeEqual(expectedSignature, signatureB64)) {
      return null;
    }

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as JWTPayload;

    // Validate issuer
    if (payload.iss !== JWT_ISSUER) {
      return null;
    }

    // Validate expiration
    if (payload.exp !== undefined && Date.now() / 1000 >= payload.exp) {
      return null;
    }

    if (typeof payload.userId === "string" && typeof payload.email === "string") {
      return { userId: payload.userId, email: payload.email };
    }
    return null;
  } catch {
    return null;
  }
}
