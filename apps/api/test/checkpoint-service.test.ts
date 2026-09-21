import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointRecord } from "@dai/db";
import {
  CheckpointCollector,
  redoCheckpoint,
  redoLatest,
  undoCheckpoint,
  undoLatest,
} from "../src/lib/checkpoint-service.js";
import { FakeWorkspace, memoryCheckpointDb, type MemoryCheckpointDb } from "./fakes.js";

/**
 * `checkpoint-service` is the undo path: the only thing that lets a user take
 * back what the agent did. It reaches Postgres for the records and the runtime
 * for the writes, so both are stubbed here and every assertion is about which
 * bytes were captured and what was sent back.
 */
const holder = vi.hoisted(() => ({ db: null as MemoryCheckpointDb | null }));
vi.mock("@dai/db", async () => {
  const fakes = await import("./fakes.js");
  const db = fakes.memoryCheckpointDb();
  holder.db = db;
  return fakes.installMemoryDb(db) as Record<string, unknown>;
});

function db(): MemoryCheckpointDb {
  if (!holder.db) throw new Error("the in-memory checkpoint store was not installed");
  return holder.db;
}

const A = "/workspace/src/a.ts";
const B = "/workspace/src/b.ts";
const C = "/workspace/src/c.ts";

function workspaceWith(
  files: Record<string, string>,
  options: { binary?: string[]; conflict?: string[] } = {}
) {
  return new FakeWorkspace({ files, binary: options.binary, conflict: options.conflict });
}

function flushOf(collector: CheckpointCollector, workspace: FakeWorkspace, label = "AI changed files") {
  return collector.flush(workspace, "proj-1", "run-1", label);
}

/** Stand in for the agent's writes landing, bypassing the journal. */
function land(workspace: FakeWorkspace, writes: Array<{ path: string; content: string | null }>): void {
  for (const write of writes) {
    if (write.content === null) workspace.files.delete(write.path);
    else workspace.files.set(write.path, write.content);
  }
}

beforeEach(() => {
  db().reset();
});

describe("pre-image capture", () => {
  it("reads every planned path in ONE batched request", async () => {
    const workspace = workspaceWith({ [A]: "one", [B]: "two", [C]: "three" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "modify", newContent: "one!" });
    collector.plan({ path: B, kind: "modify", newContent: "two!" });
    collector.plan({ path: C, kind: "create", newContent: "three!" });
    expect(collector.size).toBe(3);

    await flushOf(collector, workspace);

    expect(workspace.batchReads).toEqual([[A, B, C]]);
    // One read per file would be one Sandbox command per file.
    expect(workspace.readFileCalls).toHaveLength(0);
  });

  it("keeps the original pre-image when the same path is planned twice", async () => {
    const workspace = workspaceWith({ [A]: "original" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "modify", newContent: "first draft" });
    collector.plan({ path: A, kind: "modify", newContent: "second draft" });

    const flushed = await flushOf(collector, workspace);
    const file = flushed.checkpoint?.files[0];

    expect(workspace.batchReads).toEqual([[A]]);
    expect(file?.contentBefore).toBe("original");
    // The state the user will actually find is the last planned one.
    expect(file?.contentAfter).toBe("second draft");
    expect(file?.existedBefore).toBe(true);
    expect(file?.sizeBefore).toBe(Buffer.byteLength("original", "utf8"));
    expect(file?.sizeAfter).toBe(Buffer.byteLength("second draft", "utf8"));
  });

  it("records a created file as not existing before, and a deletion as null content after", async () => {
    const workspace = workspaceWith({ [A]: "doomed" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: B, kind: "create", newContent: "brand new" });
    collector.plan({ path: A, kind: "delete", newContent: null });

    const flushed = await flushOf(collector, workspace);
    const created = flushed.checkpoint?.files.find((file) => file.path === B);
    const deleted = flushed.checkpoint?.files.find((file) => file.path === A);

    expect(created).toMatchObject({ existedBefore: false, contentBefore: null, reversible: true });
    expect(deleted).toMatchObject({
      existedBefore: true,
      contentBefore: "doomed",
      contentAfter: null,
      changeKind: "delete",
      sizeAfter: 0,
    });
  });

  it("resets after a flush so the next batch is its own checkpoint", async () => {
    const workspace = workspaceWith({ [A]: "one" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "modify", newContent: "two" });
    await flushOf(collector, workspace);
    expect(collector.size).toBe(0);
    await expect(flushOf(collector, workspace)).resolves.toEqual({ checkpoint: null, nonReversible: [] });
    expect(workspace.batchReads).toHaveLength(1);
  });

  it("captures what is on disk now, which is why it must run before the writes", async () => {
    const workspace = workspaceWith({ [A]: "before" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "modify", newContent: "after" });
    const flushed = await flushOf(collector, workspace);
    // Nothing has been applied yet: the fake still holds the old bytes.
    expect(workspace.tree()[A]).toBe("before");
    expect(flushed.checkpoint?.files[0]?.contentBefore).toBe("before");
  });

  it("plans a rename as remove-source plus create-target", async () => {
    const workspace = workspaceWith({ [A]: "contents" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: B, kind: "rename", newContent: "contents", fromPath: A });

    const flushed = await flushOf(collector, workspace);
    expect(workspace.batchReads).toEqual([[A, B]]);
    const source = flushed.checkpoint?.files.find((file) => file.path === A);
    const target = flushed.checkpoint?.files.find((file) => file.path === B);
    // Undoing a rename is delete(new) + restore(old).
    expect(source).toMatchObject({ changeKind: "rename", contentBefore: "contents", contentAfter: null });
    expect(target).toMatchObject({ changeKind: "rename", contentBefore: null, contentAfter: "contents" });
  });
});

describe("non-reversible files", () => {
  const LARGE = "x".repeat(500);

  async function mixed() {
    const workspace = workspaceWith({ [A]: "small", [B]: LARGE, [C]: "\u0000\u0001 bytes" }, { binary: [C] });
    const collector = new CheckpointCollector(100);
    collector.plan({ path: A, kind: "modify", newContent: "small edit" });
    collector.plan({ path: B, kind: "modify", newContent: "big edit" });
    collector.plan({ path: C, kind: "modify", newContent: "binary edit" });
    const flushed = await flushOf(collector, workspace);
    return { workspace, flushed };
  }

  it("records an oversized file as non-reversible, with the reason shown to the user", async () => {
    const { flushed } = await mixed();
    const big = flushed.checkpoint?.files.find((file) => file.path === B);
    expect(big?.reversible).toBe(false);
    expect(big?.skipReason).toContain("file is 500 bytes, above the 100 byte checkpoint limit");
    expect(flushed.nonReversible.map((entry) => entry.path)).toContain(B);
  });

  it("records a binary file as non-reversible and keeps its bytes out of the record", async () => {
    const { flushed } = await mixed();
    const binary = flushed.checkpoint?.files.find((file) => file.path === C);
    expect(binary?.reversible).toBe(false);
    expect(binary?.skipReason).toMatch(/binary/);
    expect(binary?.contentBefore).toBeNull();
  });

  it("still records the reversible files, and marks the whole checkpoint unreversible", async () => {
    const { flushed } = await mixed();
    expect(flushed.checkpoint?.files.find((file) => file.path === A)?.reversible).toBe(true);
    expect(flushed.checkpoint?.reversible).toBe(false);
    expect(flushed.checkpoint?.note).toBe("2 file(s) cannot be restored automatically");
  });

  it("refuses to undo such a checkpoint instead of half-restoring it", async () => {
    const { workspace, flushed } = await mixed();
    const outcome = await undoCheckpoint(workspace, "proj-1", flushed.checkpoint?.id ?? "");
    expect(outcome.status).toBe("blocked");
    expect(outcome.message).toContain(B);
    expect(outcome.message).toContain("binary content is not restorable from a text checkpoint");
    // Nothing was guessed at: no write was ever attempted.
    expect(workspace.appliedMutations).toHaveLength(0);
    expect(workspace.tree()[B]).toBe(LARGE);
  });

  it("skips a non-reversible path even when the record was stored as restorable", async () => {
    // The DB is the authority on what undo attempts, so this pins the filter:
    // only reversible rows are ever sent to the runtime.
    db().seed({
      id: "ckpt-mixed",
      projectId: "proj-1",
      runId: "run-1",
      label: "mixed",
      status: "applied",
      reversible: true,
      note: null,
      createdAt: new Date().toISOString(),
      undoneAt: null,
      files: [
        {
          path: A,
          changeKind: "modify",
          contentBefore: "before",
          contentAfter: "after",
          existedBefore: true,
          sizeBefore: 6,
          sizeAfter: 5,
          reversible: true,
          skipReason: null,
        },
        {
          path: B,
          changeKind: "modify",
          contentBefore: null,
          contentAfter: null,
          existedBefore: false,
          sizeBefore: 0,
          sizeAfter: 0,
          reversible: false,
          skipReason: "binary content is not restorable from a text checkpoint",
        },
      ],
    });
    const workspace = workspaceWith({ [A]: "after", [B]: "still binary" });
    const outcome = await undoCheckpoint(workspace, "proj-1", "ckpt-mixed");
    const entries = workspace.appliedMutations[0] ?? [];
    expect(entries.map((entry) => entry.path)).toEqual([A]);
    expect(outcome.results.every((result) => result.status === "restored")).toBe(true);
    expect(outcome.status).toBe("undone");
    expect(workspace.tree()[B]).toBe("still binary");
  });

  it("reports an unreadable path as non-reversible rather than assuming it was absent", async () => {
    const workspace = new FakeWorkspace({ files: {}, unreadable: { [A]: "EACCES" } });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "modify", newContent: "whatever" });
    const flushed = await flushOf(collector, workspace);
    expect(flushed.nonReversible[0]?.reason).toBe("could not read the current file (EACCES)");
    expect(flushed.checkpoint?.files[0]?.reversible).toBe(false);
  });
});

describe("undo and redo", () => {
  async function checkpoint() {
    const workspace = workspaceWith({ [A]: "a before", [B]: "b before" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "modify", newContent: "a after" });
    collector.plan({ path: B, kind: "modify", newContent: "b after" });
    const flushed = await flushOf(collector, workspace, "AI changed a.ts and b.ts");
    land(workspace, [
      { path: A, content: "a after" },
      { path: B, content: "b after" },
    ]);
    workspace.appliedMutations.length = 0;
    workspace.order.length = 0;
    return { workspace, id: flushed.checkpoint?.id ?? "" };
  }

  it("puts back what was there and expects to find what the agent left", async () => {
    const { workspace, id } = await checkpoint();
    const outcome = await undoCheckpoint(workspace, "proj-1", id);

    expect(outcome.status).toBe("undone");
    expect(workspace.appliedMutations).toHaveLength(1);
    expect(workspace.appliedMutations[0]).toEqual([
      { path: A, content: "a before", expectCurrent: "a after" },
      { path: B, content: "b before", expectCurrent: "b after" },
    ]);
    expect(workspace.tree()).toMatchObject({ [A]: "a before", [B]: "b before" });
    expect(db().statusHistory()).toEqual([{ id, status: "undone" }]);
  });

  it("deletes a file the agent created, rather than emptying it", async () => {
    const workspace = workspaceWith({});
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "create", newContent: "created by the agent" });
    const flushed = await flushOf(collector, workspace);
    land(workspace, [{ path: A, content: "created by the agent" }]);

    const outcome = await undoCheckpoint(workspace, "proj-1", flushed.checkpoint?.id ?? "");
    expect(outcome.status).toBe("undone");
    const applied = workspace.appliedMutations[0] ?? [];
    expect(applied[0]).toMatchObject({ path: A, content: null, expectCurrent: "created by the agent" });
    expect(workspace.tree()[A]).toBeUndefined();
  });

  it("redo is the exact inverse of undo", async () => {
    const { workspace, id } = await checkpoint();
    await undoCheckpoint(workspace, "proj-1", id);
    const undone = workspace.appliedMutations[0] ?? [];
    workspace.appliedMutations.length = 0;

    const redo = await redoCheckpoint(workspace, "proj-1", id);
    expect(redo.status).toBe("redone");
    const reapplied = workspace.appliedMutations[0] ?? [];
    expect(reapplied.map((entry) => entry.path)).toEqual(undone.map((entry) => entry.path));
    for (let index = 0; index < reapplied.length; index += 1) {
      const back = undone[index]!;
      const forward = reapplied[index]!;
      expect(forward.content).toBe(back.expectCurrent);
      expect(forward.expectCurrent).toBe(back.content);
    }
    expect(workspace.tree()).toMatchObject({ [A]: "a after", [B]: "b after" });
  });

  it("reports a conflict and leaves the newer content alone", async () => {
    const { workspace, id } = await checkpoint();
    // Someone edited a.ts after the agent did.
    land(workspace, [{ path: A, content: "written by the user" }]);

    const outcome = await undoCheckpoint(workspace, "proj-1", id);
    const conflict = outcome.results.find((result) => result.path === A);
    expect(conflict?.status).toBe("conflict");
    expect(conflict?.detail).toBe("content changed since the checkpoint");
    expect(outcome.status).toBe("partial");
    expect(outcome.message).toBe("1 file(s) changed since the checkpoint and were left alone.");
    expect(workspace.tree()[A]).toBe("written by the user");
    // The file the agent still owns was restored.
    expect(workspace.tree()[B]).toBe("b before");
    expect(db().statusHistory()).toEqual([{ id, status: "partial" }]);
  });

  it("reports a partial restore rather than claiming success", async () => {
    const workspace = workspaceWith({ [A]: "a before", [B]: "b before" });
    const collector = new CheckpointCollector(10_000);
    collector.plan({ path: A, kind: "modify", newContent: "a after" });
    collector.plan({ path: B, kind: "modify", newContent: "b after" });
    const flushed = await flushOf(collector, workspace);
    land(workspace, [
      { path: A, content: "a after" },
      { path: B, content: "b after" },
    ]);
    // A vanished entirely: undo cannot restore what it does not own any more.
    workspace.files.delete(B);

    const outcome = await undoCheckpoint(workspace, "proj-1", flushed.checkpoint?.id ?? "");
    expect(outcome.status).toBe("partial");
    expect(outcome.results.map((result) => result.status)).toEqual(["restored", "conflict"]);
    expect(outcome.results[1]?.detail).toBe("file no longer exists");
  });

  it("sends one batched command and forwards the caller's timeout", async () => {
    const { workspace, id } = await checkpoint();
    await undoCheckpoint(workspace, "proj-1", id, 4_500);
    expect(workspace.order).toEqual(["applyFileMutations(2)"]);
    expect(workspace.appliedMutations[0]).toHaveLength(2);
    expect(workspace.mutationOptions[0]).toEqual({ timeoutMs: 4_500 });
  });

  it("blocks on a checkpoint id that is not this project's", async () => {
    const workspace = workspaceWith({});
    const outcome = await undoCheckpoint(workspace, "proj-1", "ckpt-nope");
    expect(outcome.status).toBe("blocked");
    expect(outcome.message).toBe("No such checkpoint for this project.");
    expect(workspace.appliedMutations).toHaveLength(0);
  });

  it("tells the header button there is nothing to undo or redo", async () => {
    const workspace = workspaceWith({});
    expect((await undoLatest(workspace, "proj-empty")).message).toBe("Nothing to undo for this project yet.");
    expect((await redoLatest(workspace, "proj-empty")).message).toBe("Nothing to redo.");
  });

  it("undoes the newest applied checkpoint and redoes the oldest undone one", async () => {
    const { workspace, id } = await checkpoint();
    const undone = await undoLatest(workspace, "proj-1");
    expect(undone.checkpointId).toBe(id);
    expect(undone.status).toBe("undone");

    const redone = await redoLatest(workspace, "proj-1");
    expect(redone.status).toBe("redone");
    expect(workspace.tree()).toMatchObject({ [A]: "a after", [B]: "b after" });
  });

  it("scopes every lookup to the project, so another tenant's id is not restorable", async () => {
    const { id } = await checkpoint();
    const workspace = workspaceWith({});
    const outcome = await undoCheckpoint(workspace, "someone-else", id);
    expect(outcome.status).toBe("blocked");
    expect(workspace.appliedMutations).toHaveLength(0);
  });

  it("returns the checkpoint's own label, which is what the Undo button shows", async () => {
    const { workspace, id } = await checkpoint();
    const record = (await db().getCheckpoint(id, "proj-1")) as CheckpointRecord;
    expect(record.label).toBe("AI changed a.ts and b.ts");
    const outcome = await undoCheckpoint(workspace, "proj-1", id);
    expect(outcome.label).toBe(record.label);
  });
});
