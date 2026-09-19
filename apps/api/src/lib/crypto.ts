import crypto from "crypto";
import { ENCRYPTION_KEY } from "./env.js";

/**
 * AES-256-GCM for user NIM API keys.
 * Output format: iv:tag:ciphertext (all hex). Authenticated encryption —
 * tampering with any part fails decryption.
 */

function key(): Buffer {
  const raw = ENCRYPTION_KEY() || "dai-development-encryption-key-32byte";
  return crypto.createHash("sha256").update(raw).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(packed: string): string | null {
  try {
    const parts = packed.split(":");
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, dataHex] = parts as [string, string, string];
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
