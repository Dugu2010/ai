import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { requireCsrf, generateCsrfToken } from "@/lib/csrf";
import { MAX_REQUEST_BODY_SIZE } from "@/lib/size-limits";

const ENCRYPTION_KEY = process.env.DAI_API_KEY_ENCRYPTION_KEY!;
if (!ENCRYPTION_KEY) {
  throw new Error("DAI_API_KEY_ENCRYPTION_KEY environment variable is required");
}

function encrypt(data: string): string {
  const crypto = require("crypto");
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32));
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(encrypted: string): string {
  const crypto = require("crypto");
  const parts = encrypted.split(":");
  if (parts.length !== 2) return "";
  const iv = Buffer.from(parts[0] || "", "hex");
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32));
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(parts[1], "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export async function GET(request: NextRequest) {
  try {
    const user = getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { pool } = require("@dai/db");
    const result = await pool.query(
      "SELECT encrypted_api_key FROM users WHERE id = $1",
      [user.userId]
    );
    const apiKey = result.rows[0]?.encrypted_api_key ? decrypt(result.rows[0].encrypted_api_key) : "";
    return NextResponse.json({ apiKey });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

const _saveApiKey = async (request: NextRequest) => {
  try {
    const user = getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY_SIZE) {
      return NextResponse.json({ error: "Request body exceeds maximum size" }, { status: 413 });
    }

    const { apiKey } = await request.json();
    if (!apiKey) {
      return NextResponse.json({ error: "API key required" }, { status: 400 });
    }
    const { pool } = require("@dai/db");
    await pool.query(
      "UPDATE users SET encrypted_api_key = $1 WHERE id = $2",
      [encrypt(apiKey), user.userId]
    );
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
};

export const POST = requireCsrf(_saveApiKey);

export const DELETE = requireCsrf(async (request: NextRequest) => {
  try {
    const user = getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { pool } = require("@dai/db");
    await pool.query(
      "UPDATE users SET encrypted_api_key = NULL WHERE id = $1",
      [user.userId]
    );
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
});
