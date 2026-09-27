/**
 * Blob storage for checkpoint file images.
 *
 * A checkpoint stores the exact bytes before and after every path a run touched.
 * Keeping those in Postgres `TEXT` columns means the database holds a full copy of
 * every version of every file the agent ever wrote, and the Changes panel's list
 * query has to be carefully shaped to avoid pulling them across the wire. R2 is
 * where large immutable payloads belong: it is billed by storage rather than
 * egress, and reading one back costs no compute anywhere.
 *
 * The shape deliberately matches `WorkspaceMirror`'s object store so both share
 * one client, one prefix scheme and one set of credentials.
 */

import type { ObjectStore } from "./object-store.js";

/** Which of the two images of a file is being stored. */
type ImageSide = "before" | "after";

export interface StedImage {
  /** Opaque key the caller stores alongside the checkpoint row. */
  key: string;
}

export class CheckpointBlobs {
  private readonly store: ObjectStore;
  private readonly prefix: string;

  constructor(deps: { store: ObjectStore; rootPrefix: string }) {
    this.store = deps.store;
    this.prefix = deps.rootPrefix.replace(/^\/+|\/+$/g, "");
  }

  /**
   * One key per (checkpoint, file, side).
   *
   * The file index is positional, matching the order rows are written and read
   * back (`ORDER BY id ASC`), so no extra column is needed to find an image
   * again. Paths are deliberately absent: two files in one checkpoint could
   * otherwise collide after a rename reuses a name.
   */
  private keyFor(checkpointId: string, fileIndex: number, side: ImageSide): string {
    return `${this.prefix}/checkpoints/${checkpointId}/${fileIndex}-${side}`;
  }

  async put(
    checkpointId: string,
    fileIndex: number,
    side: ImageSide,
    content: string
  ): Promise<StedImage> {
    const key = this.keyFor(checkpointId, fileIndex, side);
    await this.store.put(key, content, "text/plain; charset=utf-8");
    return { key };
  }

  async get(key: string): Promise<string | null> {
    const bytes = await this.store.get(key);
    return bytes === null ? null : bytes.toString("utf8");
  }

  /**
   * Drop every image for one checkpoint.
   *
   * Called when a checkpoint row goes away; without it the objects outlive the
   * row that names them and quietly consume the storage allowance forever.
   */
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    await this.store.deletePrefix(`${this.prefix}/checkpoints/${checkpointId}/`);
  }
}
