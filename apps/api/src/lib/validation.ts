import { resolve, relative, isAbsolute, normalize } from "path";

export const WORKSPACE_ROOT = "/workspace";

export interface PathValidationResult {
  valid: boolean;
  normalized: string | null;
  error?: string;
}

export function validatePath(inputPath: string): PathValidationResult {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return { valid: false, normalized: null, error: "Path is required and must be non-empty" };
  }
  try {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(inputPath);
    } catch {
      return { valid: false, normalized: null, error: "Invalid URL-encoded path" };
    }
    if (/[\x00-\x1f\x7f]/.test(decodedPath)) {
      return { valid: false, normalized: null, error: "Path contains invalid characters" };
    }
    const normalizedPath = normalize(resolve(decodedPath));
    if (!isAbsolute(normalizedPath)) {
      return { valid: false, normalized: null, error: "Path must be absolute" };
    }
    if (normalizedPath.includes("..")) {
      return { valid: false, normalized: null, error: "Path contains traversal sequence" };
    }
    const rel = relative(WORKSPACE_ROOT, normalizedPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { valid: false, normalized: null, error: "Path escapes workspace boundaries" };
    }
    if (normalizedPath !== WORKSPACE_ROOT && !normalizedPath.startsWith(WORKSPACE_ROOT + "/")) {
      return { valid: false, normalized: null, error: "Path escapes workspace boundaries" };
    }
    return { valid: true, normalized: normalizedPath };
  } catch (error: any) {
    return { valid: false, normalized: null, error: `Invalid path format: ${error.message}` };
  }
}

export const MAX_TIMEOUT_MS = 300000;
export const SAFE_COMMANDS = [
  "npm", "node", "python", "python3", "pip", "pip3", "git", "npx", "yarn", "pnpm",
  "bash", "sh", "tsx", "ts-node", "tsc", "esbuild", "webpack", "rollup", "vite",
  "next", "npm-run-all", "concurrently", "wait-on", "ls", "cat", "mkdir", "echo",
];

const DANGEROUS_PATTERNS = [
  /^curl\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /^wget\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /^chmod\s+.*777/,
  /^rm\s+(-r+|-rf|-fr)\s+\/+/,
  /^rm\s+(-r+|-rf|-fr)\s+\/+[^s]/,
  /^dd\s+if=\/dev\/zero/,
  /;.*rm\s+(-r+|-rf|-fr)/,
  /\|.*curl\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /&&.*curl\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /sudo\s+rm/,
];

export interface CommandValidationResult {
  valid: boolean;
  error?: string;
}

export function validateCommand(command: string): CommandValidationResult {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { valid: false, error: "Command is required" };
  }
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/)[0];
  if (!firstWord) return { valid: false, error: "Command is required" };
  const baseCommand = firstWord.replace(/^[^a-zA-Z0-9]*/, "");
  if (!SAFE_COMMANDS.includes(baseCommand)) {
    return {
      valid: false,
      error: `Command "${baseCommand}" is not allowed. Allowed: ${SAFE_COMMANDS.join(", ")}`,
    };
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: "Command contains dangerous patterns" };
    }
  }
  return { valid: true };
}

export function validateCommandOptions(body: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): CommandValidationResult {
  const { command, cwd, timeoutMs } = body;
  if (!command) return { valid: false, error: "Command is required" };
  const commandValidation = validateCommand(command);
  if (!commandValidation.valid) return commandValidation;
  if (cwd) {
    const pathValidation = validatePath(cwd);
    if (!pathValidation.valid) {
      return { valid: false, error: `Invalid cwd: ${pathValidation.error}` };
    }
  }
  if (timeoutMs !== undefined && timeoutMs > MAX_TIMEOUT_MS) {
    return { valid: false, error: `Timeout cannot exceed ${MAX_TIMEOUT_MS}ms (5 minutes)` };
  }
  return { valid: true };
}

export const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB
export const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB
export const MAX_FILE_READ_SIZE = 1024 * 1024; // 1MB
