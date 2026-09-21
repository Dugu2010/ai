/**
 * Undo / rollback.
 *
 * A checkpoint records the pre-image and post-image of every path an agent run
 * intended to change. Pre-images are captured in ONE batched read at flush time,
 * not one read per write, and restore is ONE batched command.
 *
 * Two properties matter more than convenience:
 *  - a checkpoint that cannot be restored faithfully says so, and
 *  - restoring never overwrites content the agent did not itself write.
 */

import {
  createCheckpoint,
  findLatestAppliedCheckpoint,
  findNextUndoneCheckpoint,
  getCheckpoint,
  setCheckpointStatus,
  type CheckpointFileRecord,
  type CheckpointRecord,
} from "@dai/db";
import type { MutationResult, Workspace } from "@dai/modal";

export type ChangeKind = CheckpointFileRecord["changeKind"];

export interface PlannedChange {
  path: string;
  kind: ChangeKind;
  /** Content the file will hold afterwards; null means it will not exist. */
  newContent: string | null;
  /** For renames, the path the file is moving from. */
  fromPath?: string;
}

interface Accumulated {
  kind: ChangeKind;
  /** First-seen planned result, kept so a re-edit does not lose the original. */
  newContent: string | null;
  fromPath?: string;
}

export interface FlushResult {
  checkpoint: CheckpointRecord | null;
  /** Paths the checkpoint cannot restore, with the reason shown to the user. */
  nonReversible: Array<{ path: string; reason: string }>;
}

/**
 * Collects intended edits for one agent run and turns them into a checkpoint.
 *
 * Paths are deduplicated keeping the *last* planned content, because that is the
 * state the user will find; the pre-image that matters for undo is whatever is on
 * disk before the run's first write, which is what the batched read observes at
 * flush time — before any of the planned writes have been applied.
 */
export class CheckpointCollector {
  private readonly planned = new Map<string, Accumulated>();

  /**
   * @param maxFileBytes files at or above this size are recorded as
   *   non-reversible rather than stored. Sourced from the same budget config the
   *   runtime uses, so there is one ceiling and not two.
   */
  constructor(private readonly maxFileBytes: number) {}

  get size(): number {
    return this.planned.size;
  }

  plan(change: PlannedChange): void {
    if (change.kind === "rename" && change.fromPath) {
      // A rename is undoable as delete(new) + restore(old).
      this.planned.set(change.fromPath, { kind: "rename", newContent: null });
      this.planned.set(change.path, {
        kind: "rename",
        newContent: change.newContent,
        fromPath: change.fromPath,
      });
      return;
    }
    this.planned.set(change.path, {
      kind: change.kind,
      newContent: change.newContent,
    });
  }

  /**
   * Persist a checkpoint. Must be called BEFORE the planned writes are applied,
   * so that the captured pre-images are the real "before" state.
   */
  async flush(workspace: Workspace, projectId: string, runId: string, label: string): Promise<FlushResult> {
    if (this.planned.size === 0) return { checkpoint: null, nonReversible: [] };

    const paths = [...this.planned.keys()];
    const observed = await workspace.readFilesBatch(paths);

    const files: CheckpointFileRecord[] = [];
    const nonReversible: FlushResult["nonReversible"] = [];
    let allReversible = true;

    for (const [path, change] of this.planned) {
      const entry = observed[path];
      let contentBefore: string | null = null;
      let existedBefore = false;
      let sizeBefore = 0;
      let reversible = true;
      let skipReason: string | null = null;

      if (!entry) {
        reversible = false;
        skipReason = "the runtime did not report this path";
      } else if ("error" in entry) {
        reversible = false;
        skipReason = `could not read the current file (${entry.error})`;
      } else if (entry.exists === false) {
        existedBefore = false;
      } else if (!entry.isText) {
        reversible = false;
        skipReason = "binary content is not restorable from a text checkpoint";
      } else if (entry.size > this.maxFileBytes) {
        reversible = false;
        skipReason = `file is ${entry.size} bytes, above the ${this.maxFileBytes} byte checkpoint limit`;
      } else {
        existedBefore = true;
        contentBefore = entry.content;
        sizeBefore = entry.size;
      }

      const sizeAfter = change.newContent === null ? 0 : Buffer.byteLength(change.newContent, "utf8");
      if (!reversible) {
        allReversible = false;
        nonReversible.push({ path, reason: skipReason ?? "unknown" });
      }

      files.push({
        path,
        changeKind: change.kind,
        contentBefore,
        contentAfter: change.newContent,
        existedBefore,
        sizeBefore,
        sizeAfter,
        reversible,
        skipReason,
      });
    }

    const id = await createCheckpoint({
      projectId,
      runId,
      label,
      reversible: allReversible,
      note: allReversible ? null : `${nonReversible.length} file(s) cannot be restored automatically`,
      files,
    });

    this.planned.clear();
    const checkpoint = await getCheckpoint(id, projectId);
    return { checkpoint, nonReversible };
  }
}

export interface RestoreOutcome {
  checkpointId: string;
  label: string;
  status: "undone" | "redone" | "partial" | "blocked";
  results: MutationResult[];
  /** Populated when the checkpoint refuses to restore, with the reason. */
  message: string | null;
}

function toRestoreEntries(files: CheckpointFileRecord[], direction: "undo" | "redo") {
  return files
    .filter((file) => file.reversible)
    .map((file) =>
      direction === "undo"
        ? {
            // Put back what was there; delete anything the agent created.
            path: file.path,
            content: file.contentBefore,
            // Only touch the file if it still holds what the agent left behind.
            expectCurrent: file.contentAfter,
          }
        : {
            path: file.path,
            content: file.contentAfter,
            expectCurrent: file.contentBefore,
          }
    );
}

async function apply(
  workspace: Workspace,
  projectId: string,
  checkpointId: string,
  direction: "undo" | "redo",
  timeoutMs?: number
): Promise<RestoreOutcome> {
  const checkpoint = await getCheckpoint(checkpointId, projectId);
  if (!checkpoint) {
    return {
      checkpointId,
      label: "unknown",
      status: "blocked",
      results: [],
      message: "No such checkpoint for this project.",
    };
  }

  if (!checkpoint.reversible) {
    const blocked = checkpoint.files.filter((file) => !file.reversible);
    return {
      checkpointId,
      label: checkpoint.label,
      status: "blocked",
      results: [],
      message: `This checkpoint cannot be ${direction === "undo" ? "undone" : "redone"} safely: ${blocked
        .map((file) => `${file.path} (${file.skipReason ?? "unknown"})`)
        .join("; ")}`,
    };
  }

  const entries = toRestoreEntries(checkpoint.files, direction);
  const results = await workspace.applyFileMutations(entries, { timeoutMs });

  const clean = results.every((result) => result.status !== "conflict" && result.status !== "error");
  if (direction === "undo") {
    await setCheckpointStatus(checkpoint.id, projectId, clean ? "undone" : "partial", null);
  } else {
    await setCheckpointStatus(checkpoint.id, projectId, clean ? "applied" : "partial", null);
  }

  const conflicts = results.filter((result) => result.status === "conflict");
  return {
    checkpointId: checkpoint.id,
    label: checkpoint.label,
    status: clean ? (direction === "undo" ? "undone" : "redone") : "partial",
    results,
    message: conflicts.length
      ? `${conflicts.length} file(s) changed since the checkpoint and were left alone.`
      : null,
  };
}

export async function undoCheckpoint(
  workspace: Workspace,
  projectId: string,
  checkpointId: string,
  timeoutMs?: number
): Promise<RestoreOutcome> {
  return apply(workspace, projectId, checkpointId, "undo", timeoutMs);
}

export async function redoCheckpoint(
  workspace: Workspace,
  projectId: string,
  checkpointId: string,
  timeoutMs?: number
): Promise<RestoreOutcome> {
  return apply(workspace, projectId, checkpointId, "redo", timeoutMs);
}

/** Undo the most recent applied checkpoint — what the header "Undo" button does. */
export async function undoLatest(
  workspace: Workspace,
  projectId: string,
  timeoutMs?: number
): Promise<RestoreOutcome> {
  const checkpoint = await findLatestAppliedCheckpoint(projectId);
  if (!checkpoint) {
    return {
      checkpointId: "",
      label: "",
      status: "blocked",
      results: [],
      message: "Nothing to undo for this project yet.",
    };
  }
  return apply(workspace, projectId, checkpoint.id, "undo", timeoutMs);
}

/** Re-apply the oldest undone checkpoint. */
export async function redoLatest(
  workspace: Workspace,
  projectId: string,
  timeoutMs?: number
): Promise<RestoreOutcome> {
  const checkpoint = await findNextUndoneCheckpoint(projectId);
  if (!checkpoint) {
    return {
      checkpointId: "",
      label: "",
      status: "blocked",
      results: [],
      message: "Nothing to redo.",
    };
  }
  return apply(workspace, projectId, checkpoint.id, "redo", timeoutMs);
}
