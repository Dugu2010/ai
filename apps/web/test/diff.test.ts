import { describe, expect, it } from "vitest";
import { diffForFile, diffLines, diffStats, MAX_DIFF_LINES_PER_FILE } from "@/lib/diff";

const src = (...lines: string[]) => lines.join("\n") + "\n";

describe("diffLines", () => {
  it("reports a single modified line with its line number", () => {
    const diff = diffLines(src("a", "b", "c"), src("a", "B", "c"));
    expect(diff.unchanged).toBe(false);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    const kinds = diff.hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "remove", "add", "context"]);
    const removed = diff.hunks[0]!.lines.find((l) => l.kind === "remove")!;
    expect(removed.text).toBe("b");
    expect(removed.oldNumber).toBe(2);
    expect(removed.newNumber).toBeNull();
  });

  it("treats identical input as no change", () => {
    const diff = diffLines(src("a", "b"), src("a", "b"));
    expect(diff.unchanged).toBe(true);
    expect(diff.hunks).toHaveLength(0);
  });

  it("handles a created file as pure addition with no pre-image numbers", () => {
    const diff = diffLines(null, src("x", "y"));
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.hunks[0]!.lines.every((l) => l.oldNumber === null)).toBe(true);
    expect(diff.hunks[0]!.lines.map((l) => l.newNumber)).toEqual([1, 2]);
  });

  it("handles a deleted file as pure removal", () => {
    const diff = diffLines(src("x", "y"), null);
    expect(diff.deletions).toBe(2);
    expect(diff.additions).toBe(0);
    expect(diff.hunks[0]!.lines.every((l) => l.newNumber === null)).toBe(true);
  });

  it("treats two empty images as unchanged", () => {
    expect(diffLines("", "").unchanged).toBe(true);
    expect(diffLines(null, null).unchanged).toBe(true);
  });

  it("separates distant edits into distinct hunks and elides the untouched middle", () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[0] = "edited head";
    after[199] = "edited tail";
    const diff = diffLines(src(...before), src(...after));
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]!.oldStart).toBe(1);
    expect(diff.hunks[1]!.oldStart).toBeGreaterThan(190);
    const rendered = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(rendered).toBeLessThan(20);
  });

  it("merges edits that sit within the context window into one hunk", () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const after = [...before];
    after[10] = "x";
    after[14] = "y";
    const diff = diffLines(src(...before), src(...after));
    expect(diff.hunks).toHaveLength(1);
    expect(diff.additions).toBe(2);
  });

  it("numbers the post-image independently of the pre-image", () => {
    // One added line at the top must shift every later new-line number by one.
    const diff = diffLines(src("a", "b"), src("n", "a", "b"));
    const lastAdd = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add");
    expect(lastAdd).toHaveLength(1);
    expect(lastAdd[0]!.newNumber).toBe(1);
    const ctx = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "context");
    expect(ctx.map((l) => [l.oldNumber, l.newNumber])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it("stays exact for a moved block rather than degrading to approximate", () => {
    const before = Array.from({ length: 60 }, (_, i) => `same ${i}`);
    const after = [...before.slice(0, 30), ...before.slice(30, 40), ...before.slice(0, 30), ...before.slice(40)];
    const diff = diffLines(src(...before), src(...after));
    expect(diff.approximate).toBe(false);
  });

  it("labels an oversized rewrite approximate instead of silently mis-diffing", () => {
    const big = (seed: string) => Array.from({ length: 4000 }, (_, i) => `${seed} ${i}`);
    const diff = diffLines(src(...big("a")), src(...big("b")));
    expect(diff.approximate).toBe(true);
    expect(diff.additions).toBe(4000);
    expect(diff.deletions).toBe(4000);
  });

  it("caps rendered lines so one huge file cannot freeze the panel", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    const after = Array.from({ length: 3000 }, (_, i) => `a${i}`);
    const diff = diffLines(src(...before), src(...after));
    const rendered = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(rendered).toBeLessThanOrEqual(MAX_DIFF_LINES_PER_FILE);
    expect(diff.approximate).toBe(true);
  });

  it("preserves whitespace-only differences as real changes", () => {
    const diff = diffLines("a\n", "a \n");
    expect(diff.unchanged).toBe(false);
  });

  it("ignores a trailing newline that does not add a line", () => {
    expect(diffLines("a\nb", "a\nb\n").unchanged).toBe(true);
  });
});

describe("diffForFile", () => {
  it("uses the change kind so a create never renders a phantom removal", () => {
    const created = diffForFile({
      contentBefore: null,
      contentAfter: src("new"),
      changeKind: "create",
    });
    expect(created.deletions).toBe(0);
    expect(created.additions).toBe(1);
  });

  it("renders a rename source as a deletion", () => {
    const deleted = diffForFile({ contentBefore: src("one", "two"), contentAfter: null, changeKind: "delete" });
    expect(deleted.deletions).toBe(2);
  });
});

describe("diffStats", () => {
  it("labels both directions", () => {
    expect(diffStats(diffLines(src("a"), src("b")))).toBe("+1 -1");
  });

  it("says so when nothing changed", () => {
    expect(diffStats(diffLines(src("a"), src("a")))).toBe("no line changes");
  });
});
