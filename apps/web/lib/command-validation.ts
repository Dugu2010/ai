import { validatePath } from "./path-validation";

export const MAX_TIMEOUT_MS = 300000;
export const MAX_OUTPUT_SIZE = 1024 * 1024;
export const SAFE_COMMANDS = ["npm", "node", "python", "python3", "pip", "pip3", "git", "npx", "yarn", "pnpm", "bash", "sh", "tsx", "ts-node", "tsx-node", "tsc", "tsx", "esbuild", "webpack", "rollup", "vite", "next", "npm-run-all", "concurrently", "wait-on"];

export const DANGEROUS_PATTERNS = [
  /^curl\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /^wget\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /^chmod\s+.*777/,
  /^rm\s+(-r+|-rf|-fr)\s+\/+/,
  /^rm\s+(-r+|-rf|-fr)\s+\/+[^s]/,
  /^:.*>/,
  /^dd\s+if=\/dev\/zero/,
  /;.*rm\s+(-r+|-rf|-fr)/,
  /\|.*curl\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /&&.*curl\s+.*\bhttps?:\/\/(?!localhost|127\.0\.0\.1|::1)/,
  /sudo\s+rm/,
];

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandValidationResult {
  valid: boolean;
  error?: string;
}

export function validateCommand(command: string): CommandValidationResult {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { valid: false, error: "Command is required" };
  }

  const trimmedCommand = command.trim();

  if (!trimmedCommand) {
    return { valid: false, error: "Command is required" };
  }
   const firstWord = trimmedCommand.split(/\s+/)[0];
   if (!firstWord) {
     return { valid: false, error: "Command is required" };
   }
   const baseCommand = firstWord.replace(/^[^a-zA-Z0-9]*/, "");

  if (!SAFE_COMMANDS.includes(baseCommand)) {
    return { valid: false, error: `Command "${baseCommand}" is not allowed. Allowed commands: ${SAFE_COMMANDS.join(", ")}` };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmedCommand)) {
      return { valid: false, error: "Command contains dangerous patterns" };
    }
  }

  return { valid: true };
}

export function validateCommandOptions(body: { command: string; cwd?: string; timeoutMs?: number }): CommandValidationResult {
  const { command, cwd, timeoutMs } = body;

  if (!command) {
    return { valid: false, error: "Command is required" };
  }

  const commandValidation = validateCommand(command);
  if (!commandValidation.valid) {
    return commandValidation;
  }

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
