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

/**
 * Destructive payloads wherever they appear, including inside a quoted
 * `bash -c '...'` body.
 *
 * The anchored patterns above can only ever see the first word of a command, so
 * they are structurally blind to anything wrapped in a shell. This second pass
 * drops the quote characters and scans the whole string. It deliberately
 * targets only filesystem root and home directories: `rm -rf node_modules` and
 * `rm -rf /workspace/build` are ordinary agent work and must keep working.
 *
 * This is defence in depth, not the boundary. `bash` and `sh` are allowlisted
 * because the agent genuinely needs shells, so isolation comes from the Modal
 * Sandbox and the per-project Volume subPath — not from this list.
 */
const PAYLOAD_PATTERNS: RegExp[] = [
  // rm <flags...> /  |  / *  (root or everything under it), but not /workspace/x
  /\brm\s+(-\S+\s+)*\/(\*|\s|$)/,
  // rm <flags...> ~  or  ~/...
  /\brm\s+(-\S+\s+)*~(\s|\/|$)/,
  /--no-preserve-root/,
  // Unconditional recursive delete of the whole mounted workspace.
  /\brm\s+(-\S+\s+)*\/workspace(\*|\s|$)/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\(\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*:/,
];

/** Strip shell quoting so a payload wrapped in `bash -c '…'` is still visible. */
function payloads(command: string): string {
  return command.replace(/['"`\\]/g, " ").replace(/\s+/g, " ").trim();
}

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
  const unwrapped = payloads(trimmed);
  for (const pattern of PAYLOAD_PATTERNS) {
    if (pattern.test(unwrapped)) {
      return { valid: false, error: "Command contains a destructive payload" };
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
