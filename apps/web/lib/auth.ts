import { NextRequest } from "next/server";

export interface AuthUser {
  userId: string;
  email: string;
}

export function getUserFromRequest(request: NextRequest): AuthUser | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const decoded = jwtVerify(token);
    if (decoded) return decoded;
  }

  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/auth_token=([^;]+)/);
    if (match && match[1]) {
      const decoded = jwtVerify(match[1]);
      if (decoded) return decoded;
    }
  }

  return null;
}

function jwtVerify(token: string): AuthUser | null {
  try {
    const payload = decodeJwt(token);
    if (payload && typeof payload.userId === "string" && typeof payload.email === "string") {
      return { userId: payload.userId, email: payload.email };
    }
    return null;
  } catch {
    return null;
  }
}

function decodeJwt(token: string): { userId: string; email: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(atob(base64).split("").map(function(c) {
      return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(""));
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}
