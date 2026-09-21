import { describe, expect, it } from "vitest";
import type { ModalClient, Sandbox } from "modal";
import { SandboxTimeoutError } from "modal";
import {
  READ_BATCH_MARKER,
  RESTORE_MARKER,
  ModalProvider,
  ModalRuntimeService,
  ModalWorkspace,
  RuntimeOperationError,
  isFailure,
} from "../src/index.js";
import type { FileMutation } from "../src/types.js";
import { FakeModalClient, FakeSandbox, testConfig } from "./fakes.js";

/**
 * The two batched primitives the whole cost model rests on.
 *
 * `applyFileMutations` and `readFilesBatch` are how a multi-file edit and a
 * multi-file pre-image read stay at ONE Sandbox command each. Everything worth
 * breaking about them is on the wire: the argv that carries the payload, the
 * payload surviving hostile paths and content verbatim, and the marker reply
 * being parsed out of whatever else the command printed. None of this reaches
 * Modal — the fake records the argv and the scripted stdout is the reply.
 */

const SCRIPT_ARGV = "/usr/bin/python3";

function workspaceFor(sandbox: FakeSandbox) {
  return new ModalWorkspace({ sandbox: sandbox as unknown as Sandbox, config: testConfig() });
}

/** The base64 JSON payload the runtime appended to the command. */
function payloadOf(sandbox: FakeSandbox, index = 0): string {
  const argv = sandbox.calls.exec[index]?.argv;
  if (!argv) throw new Error("no exec was recorded");
  return argv[argv.length - 1] ?? "";
}

function decodePayload<T>(sandbox: FakeSandbox, index = 0): T {
  return JSON.parse(Buffer.from(payloadOf(sandbox, index), "base64").toString("utf8")) as T;
}

function restoreReply(sandbox: FakeSandbox, results: unknown, noise = "") {
  sandbox.execHandlers = [
    { match: "dai-restore", stdout: `${noise}${RESTORE_MARKER}${JSON.stringify(results)}` },
  ];
}

function readReply(sandbox: FakeSandbox, outcomes: Record<string, unknown>, noise = "") {
  const encoded = Buffer.from(JSON.stringify(outcomes), "utf8").toString("base64");
  sandbox.execHandlers = [{ match: "dai-read", stdout: `${noise}${READ_BATCH_MARKER}${encoded}` }];
}

describe("applyFileMutations", () => {
  const entries: FileMutation[] = [
    { path: "/workspace/src/a.ts", content: "alpha v2", expectCurrent: "alpha" },
    { path: "/workspace/src/b.ts", content: null, expectCurrent: "beta" },
    { path: "/workspace/src/c.ts", content: "gamma", expectCurrent: null },
  ];

  it("sends the whole batch as ONE command", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    restoreReply(sandbox, []);
    await workspaceFor(sandbox).applyFileMutations(entries);

    expect(sandbox.calls.exec).toHaveLength(1);
    const argv = sandbox.calls.exec[0]!.argv;
    expect(argv[0]).toBe(SCRIPT_ARGV);
    expect(argv[1]).toBe("-c");
    expect(argv[3]).toBe("dai-restore");
    expect(decodePayload<FileMutation[]>(sandbox)).toEqual(entries);
  });

  it("carries hostile paths and content verbatim, so nothing is shell syntax", async () => {
    const path = "/workspace/'; rm -rf /workspace/ & echo $(pwned) `";
    const content = "back\nnewline\tand emoji \u{1f680}";
    const expectCurrent = "ünïcode /workspace/x.ts";
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    restoreReply(sandbox, []);
    await workspaceFor(sandbox).applyFileMutations([{ path, content, expectCurrent }]);

    const [sent] = decodePayload<FileMutation[]>(sandbox);
    expect(sent?.path).toBe(path);
    expect(sent?.content).toBe(content);
    expect(sent?.expectCurrent).toBe(expectCurrent);
    // The command is an argv array with one opaque base64 argument; the payload
    // is never concatenated into a shell string.
    expect(sandbox.calls.exec[0]!.argv.join(" ")).not.toContain("rm -rf");
  });

  it("preserves the compare-and-swap expectations untouched", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    restoreReply(sandbox, []);
    await workspaceFor(sandbox).applyFileMutations([
      { path: "/workspace/a", content: "", expectCurrent: "" },
      { path: "/workspace/b", content: "x", expectCurrent: null },
    ]);
    const sent = decodePayload<FileMutation[]>(sandbox);
    expect(sent[0]).toEqual({ path: "/workspace/a", content: "", expectCurrent: "" });
    expect(sent[1]).toEqual({ path: "/workspace/b", content: "x", expectCurrent: null });
  });

  it("round-trips the per-path statuses the script reported", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    restoreReply(sandbox, [
      { path: "/workspace/src/a.ts", status: "restored" },
      { path: "/workspace/src/b.ts", status: "deleted" },
      { path: "/workspace/src/c.ts", status: "conflict", detail: "content changed since the checkpoint" },
      { path: "/workspace/d.ts", status: "skipped", detail: "path is outside the project workspace" },
      { path: "/workspace/e.ts", status: "error", detail: "EACCES" },
    ]);
    const results = await workspaceFor(sandbox).applyFileMutations(entries);
    expect(results.map((result) => result.status)).toEqual([
      "restored",
      "deleted",
      "conflict",
      "skipped",
      "error",
    ]);
    expect(results[2]?.detail).toBe("content changed since the checkpoint");
  });

  it("finds its marker even when the command printed progress first", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    restoreReply(sandbox, [{ path: "/workspace/a.ts", status: "restored" }], "warning: node deprecation\n");
    const results = await workspaceFor(sandbox).applyFileMutations([entries[0]!]);
    expect(results).toEqual([{ path: "/workspace/a.ts", status: "restored" }]);
  });

  it("fails loudly when the script produced no result, rather than reporting success", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    sandbox.execHandlers = [{ match: "dai-restore", stdout: "nothing to see here" }];
    await expect(workspaceFor(sandbox).applyFileMutations(entries)).rejects.toSatisfy((error: unknown) =>
      isFailure(error, "rejected")
    );
  });

  it("fails loudly when the result cannot be parsed", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    sandbox.execHandlers = [{ match: "dai-restore", stdout: `${RESTORE_MARKER}not-json` }];
    const error = await workspaceFor(sandbox)
      .applyFileMutations(entries)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeOperationError);
    expect((error as RuntimeOperationError).message).toMatch(/Unable to parse mutation result/);
  });

  it("treats a deadline breach as a timeout failure, not a silent partial apply", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    sandbox.execHandlers = [{ match: "dai-restore", throws: new SandboxTimeoutError("deadline") }];
    const error = await workspaceFor(sandbox)
      .applyFileMutations(entries)
      .catch((caught: unknown) => caught);
    expect(isFailure(error, "timeout")).toBe(true);
  });

  it("does not spend a command on an empty batch", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    await expect(workspaceFor(sandbox).applyFileMutations([])).resolves.toEqual([]);
    expect(sandbox.calls.exec).toHaveLength(0);
  });

  it("rounds the command deadline up to whole seconds, which the provider requires", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    restoreReply(sandbox, []);
    await workspaceFor(sandbox).applyFileMutations([entries[0]!], { timeoutMs: 1_500 });
    expect(sandbox.calls.exec[0]!.params).toMatchObject({ timeoutMs: 2_000 });
  });
});

describe("readFilesBatch", () => {
  const paths = ["/workspace/src/a.ts", "/workspace/src/b.ts", "/workspace/missing.ts"];

  it("reads every path in ONE command", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    readReply(sandbox, {
      [paths[0]!]: { exists: true, size: 5, data: Buffer.from("alpha", "utf8").toString("base64") },
      [paths[1]!]: { exists: true, size: 4, data: Buffer.from("beta", "utf8").toString("base64") },
      [paths[2]!]: { exists: false },
    });

    const outcomes = await workspaceFor(sandbox).readFilesBatch(paths);

    expect(sandbox.calls.exec).toHaveLength(1);
    expect(sandbox.calls.exec[0]!.argv[3]).toBe("dai-read");
    expect(decodePayload<string[]>(sandbox)).toEqual(paths);
    expect(outcomes[paths[0]!]).toMatchObject({ exists: true, isText: true, content: "alpha", size: 5 });
    expect(outcomes[paths[2]!]).toEqual({ exists: false });
  });

  it("passes an unreadable path through as an error, never as absent", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    readReply(sandbox, { [paths[0]!]: { error: "EACCES: permission denied" } });
    const outcomes = await workspaceFor(sandbox).readFilesBatch(paths);
    expect(outcomes[paths[0]!]).toEqual({ error: "EACCES: permission denied" });
  });

  it("keeps bytes that do not survive a UTF-8 round trip out of `content`", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    readReply(sandbox, {
      "/workspace/logo.png": { exists: true, size: raw.length, data: raw.toString("base64") },
    });

    const outcome = (await workspaceFor(sandbox).readFilesBatch(["/workspace/logo.png"]))[
      "/workspace/logo.png"
    ];

    expect(outcome).toBeDefined();
    const fields = outcome as { exists?: boolean; isText?: boolean; content?: string | null; binary?: string | null };
    expect(fields.exists).toBe(true);
    expect(fields.isText).toBe(false);
    expect(fields.content).toBeNull();
    // The original bytes are still handed back, so a restore could use them.
    expect(Buffer.from(fields.binary ?? "", "base64")).toEqual(raw);
  });

  it("accepts text with newlines, emoji and leading spaces, unchanged", async () => {
    const text = "  export const x = 1;\n\n// \u{1f680}\n";
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    readReply(sandbox, {
      "/workspace/a.ts": { exists: true, size: Buffer.byteLength(text), data: Buffer.from(text, "utf8").toString("base64") },
    });
    const outcome = (await workspaceFor(sandbox).readFilesBatch(["/workspace/a.ts"]))["/workspace/a.ts"];
    expect(outcome).toMatchObject({ exists: true, isText: true, content: text });
  });

  it("reports a provider timeout as a timeout failure", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    sandbox.execHandlers = [{ match: "dai-read", throws: new SandboxTimeoutError("slow") }];
    await expect(workspaceFor(sandbox).readFilesBatch(paths)).rejects.toSatisfy((error: unknown) =>
      isFailure(error, "timeout")
    );
  });

  it("fails rather than returning nothing when the marker is missing", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    sandbox.execHandlers = [{ match: "dai-read", stdout: "" }];
    const error = await workspaceFor(sandbox)
      .readFilesBatch(paths)
      .catch((caught: unknown) => caught);
    expect(isFailure(error, "rejected")).toBe(true);
  });

  it("spends no command on an empty path list", async () => {
    const sandbox = new FakeSandbox({ id: "sbx-1" });
    await expect(workspaceFor(sandbox).readFilesBatch([])).resolves.toEqual({});
    expect(sandbox.calls.exec).toHaveLength(0);
  });
});

describe("workspace durability boundary", () => {
  it("mounts at the configured workspace path, keyed by that path", async () => {
    const client = new FakeModalClient();
    const service = new ModalRuntimeService({
      provider: new ModalProvider({
        config: testConfig({ workspacePath: "/srv/workspace" }),
        client: client as unknown as ModalClient,
      }),
    });
    await service.acquire({ projectId: "proj-7", existingSandboxId: null });

    const params = client.created[0]!.params as {
      workdir: string;
      volumes: Record<string, { mountOptions?: unknown }>;
    };
    // The mount key and the working directory move together: a hardcoded
    // "/workspace" here would silently mount the wrong tree.
    expect(Object.keys(params.volumes)).toEqual(["/srv/workspace"]);
    expect(params.workdir).toBe("/srv/workspace");
    expect(params.volumes["/srv/workspace"]!.mountOptions).toEqual({ subPath: "projects/proj-7" });
  });

  it("reads a preview tunnel for the port that was asked for, with its token", async () => {
    const sandbox = new FakeSandbox({
      id: "sbx-1",
      createTokenResult: { url: "https://proj.modal.run/5173", token: "tok-5173" },
    });
    const workspace = workspaceFor(sandbox);
    await expect(workspace.getPreviewUrl(5_173)).resolves.toEqual({
      url: "https://proj.modal.run/5173",
      token: "tok-5173",
    });
    expect(sandbox.calls.tokens[0]!.argv[0]).toBe("5173");
  });
});
