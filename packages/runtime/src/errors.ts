/**
 * The runtime error vocabulary shared by every provider.
 *
 * A provider SDK throws its own exception classes. The API layer must not branch
 * on those, so each provider registers a classifier that maps them onto a small
 * set of meanings, and everything above consumes only `RuntimeOperationError`.
 *
 * Providers are registered, not hardcoded, because a process can legitimately
 * load more than one at once — the runtime migration reads from the outgoing
 * provider while writing to the incoming one. Classification therefore tries
 * every registered classifier in registration order rather than assuming the
 * most recently imported module owns the answer.
 */

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
  /** The provider refused because a quota, not a fault. */
  | "quota"
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
  // Deliberately not 503: the provider is fine, the budget is spent, and a
  // caller retrying the same request cannot change that until the period resets.
  quota: { status: 429, recreate: false },
  rejected: { status: 502, recreate: false },
};

export type RuntimeErrorClassifier = (error: unknown) => RuntimeFailure | null;

const classifiers: RuntimeErrorClassifier[] = [];

/**
 * Register a provider's classifier.
 *
 * Idempotent per function identity, because a provider module is loaded for its
 * side effects and may be imported through more than one entry point.
 */
export function registerRuntimeErrorClassifier(classifier: RuntimeErrorClassifier): void {
  if (!classifiers.includes(classifier)) classifiers.push(classifier);
}

/** Test seam: forget every registered classifier. */
export function resetRuntimeErrorClassifiers(): void {
  classifiers.length = 0;
}

/** The first classifier that recognises this error wins. */
export function classifyRuntimeError(error: unknown): RuntimeFailure | null {
  for (const classify of classifiers) {
    const failure = classify(error);
    if (failure) return failure;
  }
  return null;
}

/** Wrap anything a provider threw. Unrecognised errors pass through untouched. */
export function toRuntimeError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof RuntimeOperationError) return error;
  const failure = classifyRuntimeError(error);
  if (failure) {
    const detail = error instanceof Error ? error.message : String(error);
    return new RuntimeOperationError(`${fallbackMessage}: ${detail}`, failure, { cause: error });
  }
  return error instanceof Error ? error : new Error(`${fallbackMessage}: ${String(error)}`);
}

/**
 * The failure kind of anything a provider threw, converting first.
 *
 * Callers must use this rather than testing `error instanceof
 * RuntimeOperationError`: providers throw their own classes, so an instanceof
 * check before conversion never matches.
 */
export function failureKindOf(error: unknown): RuntimeFailure | null {
  if (error instanceof RuntimeOperationError) return error.failure;
  return classifyRuntimeError(error);
}

export function isFailure(error: unknown, ...kinds: RuntimeFailure[]): boolean {
  const kind = failureKindOf(error);
  return kind !== null && kinds.includes(kind);
}
