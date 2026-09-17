import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";

const CSRF_SECRET = process.env.CSRF_SECRET || "development-secret-fallback";
const CSRF_TOKEN_EXPIRY_MS = 3600000; // 1 hour

/**
 * Generate a secure CSRF token.
 */
export function generateCsrfToken(): string {
  const timestamp = Date.now().toString();
  const randomBytes = crypto.randomBytes(32).toString("hex");
  const data = `${timestamp}-${randomBytes}`;
  const signature = crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(data)
    .digest("hex");
  return `${data}-${signature}`;
}

/**
 * Validate a CSRF token (signature check only).
 */
export function validateCsrfToken(token: string): boolean {
  try {
    const parts = token.split("-");
    if (parts.length < 3) return false;

    const signature = parts.pop();
    const data = parts.join("-");

    const expectedSignature = crypto
      .createHmac("sha256", CSRF_SECRET)
      .update(data)
      .digest("hex");

    if (signature !== expectedSignature) return false;

    // Check expiration
    const timeParts = data.split("-");
    if (timeParts.length === 0) return false;
    const timestampStr = timeParts[0];
    if (timestampStr === undefined) return false;
    const timestamp = parseInt(timestampStr);
    if (Date.now() - timestamp > CSRF_TOKEN_EXPIRY_MS) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Validate Origin/Referer header for CSRF protection.
 * Allows same-origin requests and explicitly allowed origins.
 */
export function validateOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);

  const requestOrigin = origin || referer;
  if (!requestOrigin) return false;

  try {
    const url = new URL(requestOrigin);
    const host = url.hostname;
    const protocol = url.protocol;

    // Block if requestOrigin is is
    if (requestOrigin.startsWith("data:") || requestOrigin.startsWith("blob:")) {
      return false;
    }

    // Check if origin is explicitly allowed
    if (allowedOrigins.some((o) => o === requestOrigin || o === `${protocol}//${host}`)) {
      return true;
    }

    // For same-origin requests, verify the origin matches the request URL
    const requestUrl = new URL(request.url);
    if (host === requestUrl.hostname && protocol === requestUrl.protocol) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Require CSRF validation for cookie-authenticated requests.
 * Returns a middleware-like function that can wrap route handlers.
 * Supports Next.js 13+ dynamic route handlers with params argument.
 */
export function requireCsrf(
  handler:
    | ((request: NextRequest, { params }: { params: Promise<any> }) => Promise<NextResponse>)
    | ((request: NextRequest) => Promise<NextResponse>)
) {
  return async (
    request: NextRequest,
    data?: { params: Promise<any> }
  ): Promise<NextResponse> => {
    // For POST/PUT/DELETE/PATCH, require CSRF validation
    const method = request.method.toUpperCase();
    if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
      // Check Origin/Referer
      if (!validateOrigin(request)) {
        return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
      }

      // Check CSRF token in header or form field
      const csrfToken =
        request.headers.get("x-csrf-token") ||
        (async () => {
          try {
            const contentType = request.headers.get("content-type") || "";
            if (contentType.includes("application/x-www-form-urlencoded")) {
              const body = await request.formData();
              return body.get("csrf_token") as string;
            }
            if (contentType.includes("application/json")) {
              const body = await request.json();
              return body.csrf_token;
            }
          } catch {
            return null;
          }
        })()

      const validToken = await csrfToken;
      if (!validToken || typeof validToken !== "string" || !validateCsrfToken(validToken)) {
        return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
      }
    }

    if (data) {
      return (handler as (request: NextRequest, data: { params: Promise<any> }) => Promise<NextResponse>)(request, data);
    }
    return (handler as (request: NextRequest) => Promise<NextResponse>)(request);
  };
}
