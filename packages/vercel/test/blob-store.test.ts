import { describe, expect, it } from "vitest";
import { CheckpointBlobs } from "../src/blob-store.js";
import { FakeObjectStore } from "./fakes.js";

function blobs(store = new FakeObjectStore()) {
  return { blobs: new CheckpointBlobs({ store, rootPrefix: "workspaces" }), store };
}

/**
 * Checkpoint images are the bytes undo restores from. A wrong key here is not a
 * cosmetic bug: it either deletes a user's file (pre-image read as absent) or
 * restores the wrong version of it.
 */
describe("CheckpointBlobs", () => {
  it("round-trips both images of one file", async () => {
    const { blobs: b, store } = blobs();
    const before = await b.put("ck1", 0, "before", "original text");
    const after = await b.put("ck1", 0, "after", "edited text");

    expect(store.objects.size).toBe(2);
    expect(await b.get(before.key)).toBe("original text");
    expect(await b.get(after.key)).toBe("edited text");
  });

  it("keeps the before and after images of the same file distinct", async () => {
    const { blobs: b } = blobs();
    const before = await b.put("ck1", 3, "before", "one");
    const after = await b.put("ck1", 3, "after", "two");
    expect(before.key).not.toBe(after.key);
    expect(await b.get(before.key)).toBe("one");
    expect(await b.get(after.key)).toBe("two");
  });

  it("keeps files of one checkpoint distinct by index", async () => {
    const { blobs: b } = blobs();
    const first = await b.put("ck1", 0, "before", "alpha");
    const second = await b.put("ck1", 1, "before", "beta");
    expect(await b.get(first.key)).toBe("alpha");
    expect(await b.get(second.key)).toBe("beta");
  });

  it("keeps checkpoints distinct from each other", async () => {
    const { blobs: b } = blobs();
    const a = await b.put("ck-a", 0, "before", "A");
    const c = await b.put("ck-b", 0, "before", "B");
    expect(await b.get(a.key)).toBe("A");
    expect(await b.get(c.key)).toBe("B");
  });

  it("returns null for a key that is gone, rather than throwing", async () => {
    const { blobs: b } = blobs();
    expect(await b.get("workspaces/checkpoints/missing/0-before")).toBeNull();
  });

  it("stores an empty file as empty, not as absent", async () => {
    // A zero-length pre-image is a real state; conflating it with "no object"
    // would make undo treat an emptied file as a created one.
    const { blobs: b, store } = blobs();
    const stored = await b.put("ck1", 0, "before", "");
    expect(store.objects.has(stored.key)).toBe(true);
    expect(await b.get(stored.key)).toBe("");
  });

  it("reclaims every image when its checkpoint is deleted", async () => {
    const { blobs: b, store } = blobs();
    await b.put("ck1", 0, "before", "a");
    await b.put("ck1", 0, "after", "b");
    await b.put("ck1", 1, "before", "c");
    await b.put("ck2", 0, "before", "keep");

    await b.deleteCheckpoint("ck1");

    expect(store.objects.size).toBe(1);
    expect([...store.objects.keys()][0]).toContain("ck2");
  });

  it("prefixes keys under the configured root so environments can share a bucket", async () => {
    const { blobs: b } = blobs();
    const stored = await b.put("ck1", 0, "before", "x");
    expect(stored.key.startsWith("workspaces/checkpoints/ck1/")).toBe(true);
  });
});
