/**
 * Translates Modal SDK failures into a small runtime vocabulary the API layer
 * can act on, so route handlers never branch on provider error classes.
 */

import {
  AlreadyExistsError,
  ClientClosedError,
  ConflictError,
  ExecutionError,
  FunctionTimeoutError,
  InternalFailure,
  InvalidError,
  NotFoundError,
  SandboxFilesystemDirectoryNotEmptyError,
  SandboxFilesystemError,
  SandboxFilesystemFileTooLargeError,
  SandboxFilesystemIsADirectoryError,
  SandboxFilesystemNotADirectoryError,
  SandboxFilesystemNotFoundError,
  SandboxFilesystemPathAlreadyExistsError,
  SandboxFilesystemPermissionError,
  SandboxTimeoutError,
  TimeoutError as ModalTimeoutError,
} from "modal";

export type RuntimeFailure =
  /** No usable Sandbox; the workspace itself is still durable. */
  | "unavailable"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "not_a_directory"
  | "is_a_directory"
  | "directory_not_empty"
  | "too_large"
  | "invalid"
  | "timeout"
  | "rejected";

export class RuntimeOperationError extends Error {
  readonly failure: RuntimeFailure;
  /** HTTP status the API layer should surface for this failure. */
  readonly statusCode: number;
  /** True when the caller should drop its Sandbox handle and acquire again. */
  readonly recreate: boolean;

  constructor(message: string, failure: RuntimeFailure, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "RuntimeOperationError";
    this.failure = failure;
    const mapped = STATUS_BY_FAILURE[failure];
    this.statusCode = mapped.status;
    this.recreate = mapped.recreate;
  }
}

const STATUS_BY_FAILURE: Record<RuntimeFailure, { status: number; recreate: boolean }> = {
  unavailable: { status: 503, recreate: true },
  not_found: { status: 404, recreate: false },
  already_exists: { status: 409, recreate: false },
  permission_denied: { status: 403, recreate: false },
  not_a_directory: { status: 400, recreate: false },
  is_a_directory: { status: 400, recreate: false },
  directory_not_empty: { status: 409, recreate: false },
  too_large: { status: 413, recreate: false },
  invalid: { status: 400, recreate: false },
  timeout: { status: 504, recreate: false },
  rejected: { status: 502, recreate: false },
};

function classify(error: unknown): RuntimeFailure | null {
  if (error instanceof SandboxFilesystemNotFoundError) return "not_found";
  if (error instanceof SandboxFilesystemPathAlreadyExistsError) return "already_exists";
  if (error instanceof SandboxFilesystemPermissionError) return "permission_denied";
  if (error instanceof SandboxFilesystemNotADirectoryError) return "not_a_directory";
  if (error instanceof SandboxFilesystemIsADirectoryError) return "is_a_directory";
  if (error instanceof SandboxFilesystemDirectoryNotEmptyError) return "directory_not_empty";
  if (error instanceof SandboxFilesystemFileTooLargeError) return "too_large";
  if (error instanceof SandboxFilesystemError) return "invalid";
  if (error instanceof SandboxTimeoutError || error instanceof FunctionTimeoutError) return "timeout";
  if (error instanceof ModalTimeoutError) return "timeout";
  // A Sandbox that is gone (finished, idle-timed-out, OOMed) or an App/Volume
  // reference that no longer resolves: both mean "get a new Sandbox".
  if (error instanceof NotFoundError) return "unavailable";
  if (error instanceof InvalidError) return "invalid";
  if (error instanceof AlreadyExistsError || error instanceof ConflictError) return "already_exists";
  // The gRPC stream behind a running command died: the Sandbox may still exist,
  // but this command produced no trustworthy result.
  if (error instanceof ExecutionError || error instanceof ClientClosedError || error instanceof InternalFailure) {
    return "unavailable";
  }
  return null;
}

/** Wrap anything thrown by the SDK. Non-SDK errors pass through untouched. */
export function toRuntimeError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof RuntimeOperationError) return error;
  const failure = classify(error);
  if (failure) {
    const detail = error instanceof Error ? error.message : String(error);
    return new RuntimeOperationError(`${fallbackMessage}: ${detail}`, failure, { cause: error });
  }
  return error instanceof Error ? error : new Error(`${fallbackMessage}: ${String(error)}`);
}

/**
 * The failure kind of anything the SDK threw, converting first.
 *
 * Callers must use this rather than testing `error instanceof
 * RuntimeOperationError`: the SDK throws its own classes, so an
 * instanceof check before conversion never matches.
 */
export function failureKindOf(error: unknown): RuntimeFailure | null {
  if (error instanceof RuntimeOperationError) return error.failure;
  return classify(error);
}

export function isFailure(error: unknown, ...kinds: RuntimeFailure[]): boolean {
  const kind = failureKindOf(error);
  return kind !== null && kinds.includes(kind);
}
