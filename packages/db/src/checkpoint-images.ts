/**
 * The seam that lets checkpoint file images live outside Postgres.
 *
 * Declared here rather than imported from a provider package, because the
 * database layer must not depend on any execution provider. The app wires an
 * implementation at boot; with none wired, checkpoints keep storing their images
 * inline exactly as they always have.
 */

export type CheckpointImageSide = "before" | "after";

export interface CheckpointImageStore {
  put(
    checkpointId: string,
    fileIndex: number,
    side: CheckpointImageSide,
    content: string
  ): Promise<{ key: string }>;
  /** `null` when the object is gone. */
  get(key: string): Promise<string | null>;
  deleteCheckpoint(checkpointId: string): Promise<void>;
}

let store: CheckpointImageStore | null = null;

export function setCheckpointImageStore(next: CheckpointImageStore | null): void {
  store = next;
}

export function checkpointImageStore(): CheckpointImageStore | null {
  return store;
}
