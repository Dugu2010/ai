/**
 * Maps Modal SDK failures onto the shared runtime vocabulary.
 *
 * The vocabulary itself, the HTTP status each failure carries and the
 * classification entry points all live in `@dai/runtime`. This file owns only the
 * Modal-specific recognition, and registers it so that any caller reaching for
 * `isFailure()` gets Modal answers.
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
import {
  RuntimeOperationError,
  failureKindOf,
  isFailure,
  registerRuntimeErrorClassifier,
  toRuntimeError,
  type RuntimeErrorClassifier,
  type RuntimeFailure,
} from "@dai/runtime";

const classifyModalError: RuntimeErrorClassifier = (error: unknown): RuntimeFailure | null => {
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
};

registerRuntimeErrorClassifier(classifyModalError);

export {
  RuntimeOperationError,
  failureKindOf,
  isFailure,
  toRuntimeError,
  type RuntimeFailure,
};
