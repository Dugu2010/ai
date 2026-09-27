/**
 * Maps `@vercel/sandbox` failures onto the shared runtime vocabulary.
 *
 * The SDK raises one `APIError` carrying the raw `Response`, plus a `StreamError`
 * when a running command's stream dies because the sandbox stopped underneath it.
 * There is no per-condition error class to match on, so status codes do the work.
 *
 * Recognition is structural rather than `instanceof` on purpose: the SDK ships
 * both an ESM and a CJS build, and a provider error that crosses that boundary
 * is not the same class object as the one imported here. Classifying on the
 * shape the SDK actually guarantees — an HTTP response — cannot miss that way,
 * and a missed classification turns a clean 404 into an opaque 500.
 */

import { registerRuntimeErrorClassifier, type RuntimeFailure } from "@dai/runtime";

interface ApiErrorLike extends Error {
  response?: { status?: number };
  json?: unknown;
  text?: string;
}

function isApiErrorLike(error: unknown): error is ApiErrorLike {
  if (!(error instanceof Error)) return false;
  const candidate = error as { name?: string; response?: { status?: number } };
  // `name` is checked as well as the shape because a plain object with a
  // `response` should never be mistaken for a provider rejection.
  return (candidate.name === "APIError" || candidate.constructor?.name === "APIError") && typeof candidate.response?.status === "number";
}

function isStreamErrorLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name ?? (error as { constructor?: { name?: string } }).constructor?.name;
  return name === "StreamError";
}

function statusOf(error: ApiErrorLike): number {
  return error.response?.status ?? 0;
}

function haystack(error: ApiErrorLike): string {
  const json = error.json;
  const detail = typeof json === "string" ? json : json ? JSON.stringify(json) : "";
  return `${error.message ?? ""} ${detail} ${error.text ?? ""}`.toLowerCase();
}

export const classifyVercelError: (error: unknown) => RuntimeFailure | null = (error) => {
  if (isStreamErrorLike(error)) {
    // The stream behind a live command ended. The command's result is not
    // trustworthy, but the workspace is: this is "unavailable", not "rejected".
    return "unavailable";
  }
  if (!isApiErrorLike(error)) return null;

  const status = statusOf(error);
  const text = haystack(error);

  if (status === 429) {
    // A 429 from the control plane is the platform's own quota, which is a
    // different answer from "our monthly budget is spent" but maps to the same
    // caller behaviour: back off, do not retry in a loop.
    return "quota";
  }
  if (status === 404) {
    // A missing sandbox means "nothing to resume, create one"; a missing drive or
    // project-scoped object means the thing genuinely is not there.
    return text.includes("sandbox") ? "unavailable" : "not_found";
  }
  if (status === 409) {
    // Most often: a drive already mounted read-write by another sandbox, which is
    // the platform refusing two writers rather than a fault.
    return "already_exists";
  }
  if (status === 403) return "permission_denied";
  if (status === 413) return "too_large";
  if (status === 400 || status === 422) {
    if (text.includes("timeout") || text.includes("expired")) return "timeout";
    return "invalid";
  }
  if (status === 408 || text.includes("timed out") || text.includes("timeout")) return "timeout";
  // A credential problem or an unreachable control plane is not something the
  // caller can fix by retrying with the same handle.
  if (status === 0 || status >= 500) return "unavailable";
  return "rejected";
};

registerRuntimeErrorClassifier(classifyVercelError);

