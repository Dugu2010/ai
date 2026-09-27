import { describe, expect, it } from "vitest";
import { WorkspaceMirror } from "../src/mirror.js";
import { FakeObjectStore } from "./fakes.js";

function mirrorFor(store = new FakeObjectStore()) {
  const mirror = new WorkspaceMirror({ store, rootPrefix: "workspaces", workspaceRoot: "/workspace" });
  return { mirror, store };
}

const A = "/workspace/src/a.ts";
const B = "/workspace/src/nested/b.ts";

describe("a mirror is only readable while it is trustworthy", () => {
  it("refuses to serve a project that was never synced", async () => {
    const { mirror } = mirrorFor();
    expect(await mirror.isReadable("p1")).toBe(false);
  });

  it("serves reads once synced clean", async () => {
    const { mirror } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    expect(await mirror.isReadable("p1")).toBe(true);
    expect((await mirror.readFile("p1", A))?.toString("utf8")).toBe("alpha");
  });

  it("goes unreadable the moment a command could have written behind its back", async () => {
    const { mirror } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    await mirror.markDirty("p1");
    expect(await mirror.isReadable("p1")).toBe(false);
  });

  it("becomes readable again only after a fresh sync", async () => {
    const { mirror } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    await mirror.markDirty("p1");
    await mirror.markClean("p1");
    expect(await mirror.isReadable("p1")).toBe(true);
  });

  it("treats a corrupt manifest as dirty, never as an empty project", async () => {
    const { mirror, store } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    store.objects.set("workspaces/projects/p1/manifest.json", {
      body: Buffer.from("{ not json"),
      contentType: "application/json",
    });
    expect(await mirror.isReadable("p1")).toBe(false);
  });

  it("marking dirty twice does not churn the generation counter", async () => {
    const { mirror } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    await mirror.markDirty("p1");
    const first = await mirror.readManifest("p1");
    await mirror.markDirty("p1");
    expect((await mirror.readManifest("p1")).generation).toBe(first.generation);
  });
});

describe("keys and traversal", () => {
  it("stores workspace files under the project prefix", async () => {
    const { mirror, store } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    expect(store.objects.has("workspaces/projects/p1/files/src/a.ts")).toBe(true);
  });

  it("refuses a path that escapes the workspace", async () => {
    const { mirror } = mirrorFor();
    await expect(mirror.putFile("p1", "/etc/passwd", "x")).rejects.toThrow(/outside the workspace/);
    await expect(mirror.putFile("p1", "/workspace/../etc/passwd", "x")).rejects.toThrow(/outside the workspace/);
  });

  it("rejects traversal without touching the store", async () => {
    const { mirror, store } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    store.objects.clear();
    expect(await mirror.readFile("p1", "/workspace/../workspace/src/a.ts")).toBeNull();
    expect(store.objects.size).toBe(0);
  });
});

describe("cold listing", () => {
  it("shows one directory level, folding children into directory entries", async () => {
    const { mirror } = mirrorFor();
    await mirror.putFile("p1", A, "a");
    await mirror.putFile("p1", B, "b");
    await mirror.putFile("p1", "/workspace/readme.md", "r");

    const root = await mirror.list("p1", "/workspace");
    expect(root?.map((entry) => entry.path)).toEqual(["/workspace/readme.md", "/workspace/src"]);
    expect(root?.find((entry) => entry.path === "/workspace/src")?.isDirectory).toBe(true);

    const src = await mirror.list("p1", "/workspace/src");
    expect(src?.map((entry) => entry.path)).toEqual(["/workspace/src/a.ts", "/workspace/src/nested"]);
  });

  it("reports a file's mirrored size without a stat command", async () => {
    const { mirror } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    expect(await mirror.stat("p1", A)).toEqual({ size: 5 });
    expect(await mirror.totalBytes("p1")).toBe(5);
  });
});

describe("fork and purge", () => {
  it("copies a project server-side", async () => {
    const { mirror, store } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    await mirror.copyProject("p1", "p2");

    expect(store.copies).toBe(1);
    expect((await mirror.readFile("p2", A))?.toString("utf8")).toBe("alpha");
    expect(await mirror.isReadable("p2")).toBe(true);
  });

  it("removes a project completely, manifest included", async () => {
    const { mirror, store } = mirrorFor();
    await mirror.putFile("p1", A, "alpha");
    await mirror.purgeProject("p1");
    expect(store.objects.size).toBe(0);
    expect(await mirror.isReadable("p1")).toBe(false);
  });

  it("deleting a tree takes the directory and everything under it", async () => {
    const { mirror } = mirrorFor();
    await mirror.putFile("p1", A, "a");
    await mirror.putFile("p1", B, "b");
    await mirror.deleteTree("p1", "/workspace/src/nested");
    expect(await mirror.readFile("p1", B)).toBeNull();
    expect((await mirror.readFile("p1", A))?.toString("utf8")).toBe("a");
  });
});
