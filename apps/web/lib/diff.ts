/**
 * Line diffing for the checkpoint view.
 *
 * The server stores a full pre- and post-image per file, so the diff is derived
 * here rather than trusted from a model's description of what it changed. Pure
 * and synchronous on purpose: it has no React, network or provider dependency,
 * so it can be unit-tested without a runtime and without spending credits.
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the pre-image; null for an added line. */
  oldNumber: number | null;
  /** 1-based line number in the post-image; null for a removed line. */
  newNumber: number | null;
}

export interface DiffHunk {
  lines: DiffLine[];
  oldStart: number;
  newStart: number;
}

export interface FileDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** True when the images were too large to align exactly. */
  approximate: boolean;
  unchanged: boolean;
}

/** Above this many changed lines on each side we stop trying to align them. */
const LCS_CELL_BUDGET = 4_000_000;
const CONTEXT_LINES = 3;
export const MAX_DIFF_LINES_PER_FILE = 2_000;

function splitLines(value: string | null): string[] {
  if (value === null || value === "") return [];
  const lines = value.split("\n");
  // A trailing newline produces a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = "keep" | "add" | "remove";

/**
 * Shortest edit script over lines, using common-prefix/suffix trimming first so
 * typical edits stay linear instead of paying the full LCS cost.
 */
function editScript(before: string[], after: string[]): { ops: Op[]; approximate: boolean } {
  const ops: Op[] = [];
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);

  let mid: Array<{ op: Op; text: string }>;
  let approximate = false;

  if (midBefore.length * midAfter.length > LCS_CELL_BUDGET) {
    // Too big to align without a multi-hundred-millisecond stall. Show it as a
    // wholesale replacement and label it approximate rather than pretending.
    approximate = true;
    mid = [
      ...midBefore.map((text) => ({ op: "remove" as const, text })),
      ...midAfter.map((text) => ({ op: "add" as const, text })),
    ];
  } else {
    mid = lcsScript(midBefore, midAfter);
  }

  for (let i = 0; i < head; i += 1) ops.push("keep");
  for (const step of mid) ops.push(step.op);
  for (let i = 0; i < tail; i += 1) ops.push("keep");
  return { ops, approximate };
}

/** Classic LCS backtrace. Indices are into the trimmed middle sections only. */
function lcsScript(a: string[], b: string[]): Array<{ op: Op; text: string }> {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j] ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const steps: Array<{ op: Op; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      steps.push({ op: "keep", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) {
      steps.push({ op: "remove", text: a[i]! });
      i += 1;
    } else {
      steps.push({ op: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    steps.push({ op: "remove", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    steps.push({ op: "add", text: b[j]! });
    j += 1;
  }
  return steps;
}

/**
 * Group changed lines with up to CONTEXT_LINES of surrounding context, the way
 * a unified diff does, so a 600-line file does not render 600 lines of nothing.
 */
function buildHunks(ops: Op[], before: string[], after: string[]): DiffHunk[] {
  // Re-walk with independent counters: keep and remove consume the pre-image,
  // keep and add consume the post-image, so each side advances exactly once.
  let oi = 0;
  let ni = 0;
  const lines: DiffLine[] = [];
  for (let s = 0; s < ops.length; s += 1) {
    const op = ops[s]!;
    if (op === "keep") {
      lines.push({ kind: "context", text: before[oi] ?? "", oldNumber: oi + 1, newNumber: ni + 1 });
      oi += 1;
      ni += 1;
    } else if (op === "remove") {
      lines.push({ kind: "remove", text: before[oi] ?? "", oldNumber: oi + 1, newNumber: null });
      oi += 1;
    } else {
      lines.push({ kind: "add", text: after[ni] ?? "", oldNumber: null, newNumber: ni + 1 });
      ni += 1;
    }
  }

  const changedAt = lines.map((line) => line.kind !== "context");
  const groups: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < changedAt.length; i += 1) {
    if (changedAt[i] && start === -1) start = i;
    if (!changedAt[i] && start !== -1) {
      groups.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) groups.push([start, changedAt.length - 1]);

  const merged: Array<[number, number]> = [];
  for (const group of groups) {
    const last = merged[merged.length - 1];
    if (last && group[0] - last[1] <= CONTEXT_LINES * 2) last[1] = group[1];
    else merged.push([group[0], group[1]]);
  }

  return merged.map(([from, to]) => {
    const begin = Math.max(0, from - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, to + CONTEXT_LINES);
    const slice = lines.slice(begin, end + 1);
    const firstOld = slice.find((l) => l.oldNumber !== null)?.oldNumber ?? 0;
    const firstNew = slice.find((l) => l.newNumber !== null)?.newNumber ?? 0;
    return { lines: slice, oldStart: firstOld, newStart: firstNew };
  });
}

export function diffLines(before: string | null, after: string | null): FileDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = editScript(a, b);
  const additions = ops.ops.filter((op) => op === "add").length;
  const deletions = ops.ops.filter((op) => op === "remove").length;
  let hunks = buildHunks(ops.ops, a, b);
  let truncated = false;
  if (hunks.length > 0) {
    const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    if (total > MAX_DIFF_LINES_PER_FILE) {
      const kept: DiffHunk[] = [];
      let used = 0;
      for (const hunk of hunks) {
        if (used + hunk.lines.length > MAX_DIFF_LINES_PER_FILE) break;
        kept.push(hunk);
        used += hunk.lines.length;
      }
      hunks = kept;
      truncated = true;
    }
  }
  return {
    hunks,
    additions,
    deletions,
    approximate: ops.approximate || truncated,
    unchanged: additions === 0 && deletions === 0,
  };
}

/** A file created has no pre-image; a deleted file has no post-image. */
export function diffForFile(file: {
  contentBefore: string | null;
  contentAfter: string | null;
  changeKind: string;
}): FileDiff {
  if (file.changeKind === "create") return diffLines(null, file.contentAfter);
  if (file.changeKind === "delete") return diffLines(file.contentBefore, null);
  return diffLines(file.contentBefore, file.contentAfter);
}

export function diffStats(diff: FileDiff): string {
  const parts: string[] = [];
  if (diff.additions > 0) parts.push(`+${diff.additions}`);
  if (diff.deletions > 0) parts.push(`-${diff.deletions}`);
  if (parts.length === 0) return "no line changes";
  return parts.join(" ");
}
