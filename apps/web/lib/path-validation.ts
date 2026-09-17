import { resolve, relative, isAbsolute, normalize } from "path";

const WORKSPACE_ROOT = "/workspace";

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
    // URL-decode the path to handle encoded characters
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(inputPath);
    } catch {
      return { valid: false, normalized: null, error: "Invalid URL-encoded path" };
    }

    // Reject null bytes and other control characters
    if (/[\x00-\x1f\x7f]/.test(decodedPath)) {
      return { valid: false, normalized: null, error: "Path contains invalid characters" };
    }

    // Normalize the path to resolve ., .., and multiple slashes
    const normalizedPath = normalize(resolve(decodedPath));

    if (!isAbsolute(normalizedPath)) {
      return { valid: false, normalized: null, error: "Path must be absolute" };
    }

    // Check for path traversal attempts
    if (normalizedPath.includes("..")) {
      return { valid: false, normalized: null, error: "Path contains traversal sequence" };
    }

    // Verify the path is within workspace boundaries
    const relativeToWorkspace = relative(WORKSPACE_ROOT, normalizedPath);
    if (relativeToWorkspace.startsWith("..") || isAbsolute(relativeToWorkspace) || relativeToWorkspace.startsWith("..")) {
      return { valid: false, normalized: null, error: "Path escapes workspace boundaries" };
    }

    // Verify path starts with workspace root exactly
    if (normalizedPath !== WORKSPACE_ROOT && !normalizedPath.startsWith(WORKSPACE_ROOT + "/")) {
      return { valid: false, normalized: null, error: "Path escapes workspace boundaries" };
    }

    return { valid: true, normalized: normalizedPath };
  } catch (error: any) {
    return { valid: false, normalized: null, error: `Invalid path format: ${error.message}` };
  }
}

export function normalizePath(path: string): string {
  const result = validatePath(path);
  if (!result.valid || !result.normalized) {
    throw new Error(result.error || "Invalid path");
  }
  return result.normalized;
}

export function isValidWorkspacePath(path: string): boolean {
  return validatePath(path).valid;
}
