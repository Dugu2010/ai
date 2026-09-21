/**
 * Test doubles for the API layer's runtime contract.
 *
 * `packages/modal/test/fakes.ts` stands in for the Modal *client* (Sandbox,
 * Volume, exec). This file stands in for the layer above it: the provider-neutral
 * `Workspace` contract that `apps/api` is allowed to depend on. The point is to
 * assert on *what the code asked the runtime to do* — how many commands, in what
 * order, with which paths — because that is the part that silently regresses and
 * the part that decides whether a run costs one command or forty.
 *
 * Nothing here imports the Modal SDK and nothing here can reach the network.
 */

import type { CheckpointFileRecord, CheckpointRecord } from "@dai/db";
import type {
  BatchReadResult,
  DevServerHandle,
  ExecResult,
  FileEntry,
  FileMutation,
  MutationResult,
  PreviewTarget,
  Workspace,
} from "@dai/modal";
import type { NIMClient, ChatMessage, ChatResponse, ToolCall } from "@dai/nim";
import type { ActivityEvent, ActivityEventDetail, ActivityEventType, AgentState } from "@dai/types";
import { createActivityEmitter } from "../src/lib/activity.js";

/** The provider's workspace confinement, copied from the shipped scripts. */
const WORKSPACE_PREFIX = "/workspace/";

export interface FakeWorkspaceOptions {
  files?: Record<string, string>;
  /** Paths whose bytes do not round-trip as UTF-8 text (the provider's check). */
  binary?: string[];
  /** Paths the batch reader reports as unreadable: path -> error text. */
  unreadable?: Record<string, string>;
  /** Paths that must be reported as a conflict, whatever the caller expects. */
  conflict?: string[];
  sandboxId?: string;
  /** Programmed exec replies, matched by substring of the command. */
  execResults?: Array<{ match: string } & Partial<ExecResult>>;
}

/**
 * An in-memory `Workspace` that records every request.
 *
 * `applyFileMutations` reproduces the compare-and-swap rules of
 * `packages/modal/src/restore-script.ts` exactly — including the rule that
 * `expectCurrent: null` means "this path must not exist". That fidelity is the
 * whole point: a caller that ignores it fails here the same way it fails on a
 * real Sandbox.
 */
export class FakeWorkspace implements Workspace {
  readonly sandboxId: string;
  readonly files = new Map<string, string>();

  // ---- journals ----
  /** Ordered journal of every runtime request; ordering assertions read this. */
  readonly order: string[] = [];
  readonly readFileCalls: string[] = [];
  readonly batchReads: string[][] = [];
  readonly appliedMutations: FileMutation[][] = [];
  readonly mutationOptions: Array<{ timeoutMs?: number }> = [];
  readonly execs: Array<{ command: string; cwd?: string; timeoutMs?: number }> = [];
  readonly listFilesCalls: string[] = [];
  readonly searchFileCalls: Array<{ dir: string; pattern: string }> = [];
  readonly searchContentCalls: Array<{ dir: string; pattern: string }> = [];
  readonly previewPorts: number[] = [];
  readonly devServerStarts: Array<{ command: string; port: number }> = [];
  readonly gitCalls: string[] = [];
  readonly removals: string[] = [];
  readonly renames: Array<{ from: string; to: string }> = [];

  private readonly binaryPaths: Set<string>;
  private readonly unreadablePaths: Record<string, string>;
  private readonly conflictPaths: Set<string>;
  private readonly execResults: NonNullable<FakeWorkspaceOptions["execResults"]>;

  closed = 0;
  terminated = 0;

  constructor(options: FakeWorkspaceOptions = {}) {
    this.sandboxId = options.sandboxId ?? "sbx-fake-1";
    for (const [path, content] of Object.entries(options.files ?? {})) this.files.set(path, content);
    this.binaryPaths = new Set(options.binary ?? []);
    this.unreadablePaths = options.unreadable ?? {};
    this.conflictPaths = new Set(options.conflict ?? []);
    this.execResults = options.execResults ?? [];
  }

  /** Snapshot of the tree, for "was this file actually written" assertions. */
  tree(): Record<string, string | null> {
    return Object.fromEntries(this.files.entries());
  }

  /** Count of journal entries matching a prefix, e.g. "applyFileMutations". */
  countOf(label: string): number {
    return this.order.filter((entry) => entry.startsWith(label)).length;
  }

  private note(label: string): void {
    this.order.push(label);
  }

  async exec(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number }
  ): Promise<ExecResult> {
    this.note("exec");
    this.execs.push({ command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
    const scripted = this.execResults.find((entry) => command.includes(entry.match));
    return {
      stdout: scripted?.stdout ?? "",
      stderr: scripted?.stderr ?? null,
      exitCode: scripted?.exitCode ?? 0,
      durationMs: scripted?.durationMs ?? 1,
      timedOut: scripted?.timedOut ?? false,
    };
  }

  async readFile(path: string): Promise<string | null> {
    this.note("readFile");
    this.readFileCalls.push(path);
    return this.files.get(path) ?? null;
  }

  async readFilesBatch(paths: string[]): Promise<Record<string, BatchReadResult>> {
    this.note(`readFilesBatch(${paths.length})`);
    this.batchReads.push([...paths]);
    const outcomes: Record<string, BatchReadResult> = {};
    for (const path of paths) {
      const error = this.unreadablePaths[path];
      if (error) {
        outcomes[path] = { error };
        continue;
      }
      const content = this.files.get(path);
      if (content === undefined) {
        outcomes[path] = { exists: false };
        continue;
      }
      const isText = !this.binaryPaths.has(path);
      outcomes[path] = {
        exists: true,
        isText,
        size: Buffer.byteLength(content, "utf8"),
        content: isText ? content : null,
        binary: isText ? null : Buffer.from(content, "utf8").toString("base64"),
      };
    }
    return outcomes;
  }

  async applyFileMutations(
    entries: FileMutation[],
    opts?: { timeoutMs?: number }
  ): Promise<MutationResult[]> {
    this.note(`applyFileMutations(${entries.length})`);
    this.appliedMutations.push(entries.map((entry) => ({ ...entry })));
    this.mutationOptions.push({ timeoutMs: opts?.timeoutMs });
    if (entries.length === 0) return [];
    const results: MutationResult[] = [];
    for (const entry of entries) {
      if (!entry.path.startsWith(WORKSPACE_PREFIX)) {
        results.push({ path: entry.path, status: "skipped", detail: "path is outside the project workspace" });
        continue;
      }
      const current = this.files.has(entry.path) ? (this.files.get(entry.path) as string) : null;
      let conflict: string | null = null;
      if (this.conflictPaths.has(entry.path)) {
        conflict = "forced by the test";
      } else if (entry.expectCurrent === null) {
        if (current !== null) conflict = "file exists but the checkpoint recorded it as absent";
      } else if (current === null) {
        conflict = "file no longer exists";
      } else if (current !== entry.expectCurrent) {
        conflict = "content changed since the checkpoint";
      }
      if (conflict) {
        results.push({ path: entry.path, status: "conflict", detail: conflict });
        continue;
      }
      if (entry.content === null) {
        this.files.delete(entry.path);
        results.push({ path: entry.path, status: "deleted" });
      } else {
        this.files.set(entry.path, entry.content);
        results.push({ path: entry.path, status: "restored" });
      }
    }
    return results;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.note("writeFile");
    this.files.set(path, content);
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    this.note("listFiles");
    this.listFilesCalls.push(path);
    return [...this.files.keys()]
      .filter((key) => key.startsWith(WORKSPACE_PREFIX) && key.startsWith(path === "/" ? "" : path))
      .map((key) => ({
        name: key.split("/").pop() ?? key,
        path: key,
        kind: "file" as const,
        size: Buffer.byteLength(this.files.get(key) ?? "", "utf8"),
      }));
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean } | null> {
    this.note("stat");
    if (path === "/workspace") return { size: 0, isDirectory: true };
    const content = this.files.get(path);
    return content === undefined ? null : { size: Buffer.byteLength(content, "utf8"), isDirectory: false };
  }

  async remove(path: string): Promise<void> {
    this.note("remove");
    this.removals.push(path);
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    this.note("rename");
    this.renames.push({ from, to });
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.delete(from);
      this.files.set(to, content);
    }
  }

  async mkdir(path: string): Promise<void> {
    this.note(`mkdir:${path}`);
  }

  async searchFiles(dir: string, pattern: string): Promise<string[]> {
    this.note("searchFiles");
    this.searchFileCalls.push({ dir, pattern });
    return [...this.files.keys()].filter((key) => key.startsWith(dir));
  }

  async searchContent(dir: string, pattern: string): Promise<{ path: string; line: number; content: string }[]> {
    this.note("searchContent");
    this.searchContentCalls.push({ dir, pattern });
    const matches: { path: string; line: number; content: string }[] = [];
    for (const [path, content] of this.files.entries()) {
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (line.includes(pattern)) matches.push({ path, line: index + 1, content: line });
      });
    }
    return matches;
  }

  async getGitStatus(cwd: string): Promise<{
    branch: string | null;
    staged: string[];
    modified: string[];
    untracked: string[];
    raw: string;
  }> {
    this.note("getGitStatus");
    this.gitCalls.push(cwd);
    return { branch: "main", staged: [], modified: ["src/a.ts"], untracked: [], raw: " M src/a.ts" };
  }

  async getGitDiff(cwd: string): Promise<{ staged: string; unstaged: string }> {
    this.note("getGitDiff");
    this.gitCalls.push(cwd);
    return { staged: "", unstaged: "diff --git a/src/a.ts" };
  }

  async waitForPort(port: number): Promise<boolean> {
    this.note(`waitForPort:${port}`);
    return true;
  }

  async startDevServer(opts: { command: string; port: number }): Promise<DevServerHandle> {
    this.note("startDevServer");
    this.devServerStarts.push({ command: opts.command, port: opts.port });
    return { reused: false, port: opts.port, ready: true };
  }

  async stopDevServer(port: number): Promise<void> {
    this.note(`stopDevServer:${port}`);
  }

  async getPreviewUrl(port: number): Promise<PreviewTarget> {
    this.note(`getPreviewUrl:${port}`);
    this.previewPorts.push(port);
    return { url: "https://preview.fake/3000", token: "tok-fake" };
  }

  async workspaceUsageBytes(): Promise<number | null> {
    this.note("workspaceUsageBytes");
    let total = 0;
    for (const content of this.files.values()) total += Buffer.byteLength(content, "utf8");
    return total;
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async terminate(): Promise<void> {
    this.terminated += 1;
  }

  close(): void {
    this.closed += 1;
  }
}

/* ------------------------------- model ------------------------------- */

export interface ScriptedTurn {
  content?: string | null;
  toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
}

/**
 * A `NIMClient` stand-in that replays a script. No fetch, no API key: the loop is
 * driven entirely by recorded model turns, so a test can name the exact tool
 * calls the runtime must (or must not) act on.
 */
export function scriptedNim(turns: Array<ScriptedTurn | Error>) {
  const requests: Array<{ messages: ChatMessage[]; toolCount: number }> = [];
  let index = 0;
  const nim = {
    async chat(request: {
      messages: ChatMessage[];
      tools?: unknown[];
    }): Promise<ChatResponse> {
      requests.push({ messages: request.messages, toolCount: request.tools?.length ?? 0 });
      const turn: ScriptedTurn | Error = turns[index] ?? { content: "Done." };
      index += 1;
      if (turn instanceof Error) throw turn;
      const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, position) => ({
        id: call.id ?? `call_${requests.length}_${position}`,
        name: call.name,
        arguments: call.arguments ?? {},
      }));
      return {
        content: turn.content ?? null,
        toolCalls,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: toolCalls.length ? "tool_calls" : "stop",
      };
    },
  };
  return { nim: nim as unknown as NIMClient, requests };
}

/* ------------------------------ activity ----------------------------- */

/** Emitter plus the two sinks, so ordering between them is observable. */
export function recordingEmitter(runId = "run-1", projectId = "proj-1") {
  const persisted: ActivityEvent[] = [];
  const published: ActivityEvent[] = [];
  const callOrder: string[] = [];
  const emitter = createActivityEmitter({
    runId,
    projectId,
    persist: (event) => {
      callOrder.push("persist");
      persisted.push(event);
    },
    publish: (event) => {
      callOrder.push("publish");
      published.push(event);
    },
  });
  const titles = (type: ActivityEventType) =>
    emitter.events.filter((event) => event.type === type).map((event) => event.title);
  return { emit: emitter.emit, events: emitter.events, persisted, published, callOrder, titles };
}

/* --------------------------- checkpoint store -------------------------- */

export interface MemoryCheckpointDb {
  createCheckpoint(input: {
    projectId: string;
    runId: string | null;
    label: string;
    reversible: boolean;
    note?: string | null;
    files: CheckpointFileRecord[];
  }): Promise<string>;
  getCheckpoint(checkpointId: string, projectId: string): Promise<CheckpointRecord | null>;
  setCheckpointStatus(
    checkpointId: string,
    projectId: string,
    status: "applied" | "undone" | "partial",
    note: string | null
  ): Promise<void>;
  findLatestAppliedCheckpoint(projectId: string): Promise<CheckpointRecord | null>;
  findNextUndoneCheckpoint(projectId: string): Promise<CheckpointRecord | null>;
  /** Test introspection. */
  rows(): CheckpointRecord[];
  statusHistory(): Array<{ id: string; status: string }>;
  seed(record: CheckpointRecord): void;
  reset(): void;
}

/** A tiny in-memory `@dai/db`, wired in with `vi.mock("@dai/db", ...)`. */
export function memoryCheckpointDb(): MemoryCheckpointDb {
  const stored = new Map<string, CheckpointRecord>();
  const statusHistory: Array<{ id: string; status: string }> = [];
  let sequence = 0;

  function put(record: CheckpointRecord): void {
    stored.set(record.id, record);
  }

  return {
    async createCheckpoint(input) {
      sequence += 1;
      const id = `ckpt-${sequence}`;
      put({
        id,
        projectId: input.projectId,
        runId: input.runId,
        label: input.label,
        status: "applied",
        reversible: input.reversible,
        note: input.note ?? null,
        createdAt: new Date(Date.UTC(2026, 0, sequence)).toISOString(),
        undoneAt: null,
        files: input.files.map((file) => ({ ...file })),
      });
      return id;
    },
    async getCheckpoint(checkpointId, projectId) {
      const record = stored.get(checkpointId);
      return record && record.projectId === projectId ? record : null;
    },
    async setCheckpointStatus(checkpointId, projectId, status, note) {
      const record = stored.get(checkpointId);
      if (!record || record.projectId !== projectId) return;
      statusHistory.push({ id: checkpointId, status });
      put({
        ...record,
        status,
        note: note ?? record.note,
        undoneAt: status === "undone" ? new Date().toISOString() : record.undoneAt,
      });
    },
    async findLatestAppliedCheckpoint(projectId) {
      const matches = [...stored.values()]
        .filter((record) => record.projectId === projectId && record.status === "applied")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return matches[0] ?? null;
    },
    async findNextUndoneCheckpoint(projectId) {
      const matches = [...stored.values()]
        .filter((record) => record.projectId === projectId && record.status === "undone")
        .sort((a, b) => (a.undoneAt ?? "").localeCompare(b.undoneAt ?? ""));
      return matches[0] ?? null;
    },
    rows: () => [...stored.values()],
    statusHistory: () => [...statusHistory],
    seed: (record) => put(record),
    reset: () => {
      stored.clear();
      statusHistory.length = 0;
      sequence = 0;
    },
  };
}

/** Shared `vi.mock("@dai/db")` body; returns the live stub for assertions. */
export function installMemoryDb(db: MemoryCheckpointDb): Record<string, unknown> {
  return {
    createCheckpoint: (input: Parameters<MemoryCheckpointDb["createCheckpoint"]>[0]) => db.createCheckpoint(input),
    getCheckpoint: (id: string, projectId: string) => db.getCheckpoint(id, projectId),
    setCheckpointStatus: (
      id: string,
      projectId: string,
      status: "applied" | "undone" | "partial",
      note: string | null
    ) => db.setCheckpointStatus(id, projectId, status, note),
    findLatestAppliedCheckpoint: (projectId: string) => db.findLatestAppliedCheckpoint(projectId),
    findNextUndoneCheckpoint: (projectId: string) => db.findNextUndoneCheckpoint(projectId),
  };
}

export function detail(event: ActivityEvent | undefined): ActivityEventDetail {
  return event?.detail ?? {};
}

export type { ActivityEvent, ActivityEventType, AgentState };
