/**
 * The provider-neutral contract lives in `@dai/runtime`.
 *
 * Re-exported here so that `import type { Workspace } from "@dai/modal"` keeps
 * resolving for every existing consumer, and so a provider implementation cannot
 * accidentally drift from the shape the API layer compiles against.
 */

export type {
  AcquireOptions,
  BatchReadResult,
  DevServerHandle,
  ExecResult,
  FileEntry,
  FileMutation,
  MutationResult,
  PreviewTarget,
  RuntimeService,
  RuntimeState,
  Workspace,
} from "@dai/runtime";
