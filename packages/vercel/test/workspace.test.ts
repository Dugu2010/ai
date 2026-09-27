import { describe, expect, it } from "vitest";
import type { Sandbox } from "@vercel/sandbox";
import { VercelWorkspace } from "../src/workspace.js";
import { FakeSandbox, RecordingMirror, testConfig } from "./fakes.js";

const A = "/workspace/src/a.ts";
const B = "/workspace/src/b.ts";
const C = "/workspace/src/c.ts";

interface WorkspaceFixture {
  files?: Record<string, string>;
  directories?: string[];
  binary?: Record<string, Uint8Array>;
  handlers?: { match: (argv: string[]) => boolean; result: { exitCode: number; stdout?: string; stderr?: string }; delayMs?: number }[];
  mirror?: RecordingMirror;
}

function workspaceFor(options: WorkspaceFixture = {}) {
  const sandbox = new FakeSandbox({
    ...(options.files ? { files: options.files } : {}),
    ...(options.directories ? { directories: options.directories } : {}),
    ...(options.handlers ? { handlers: options.handlers } : {}),
    ...(options.binary ? { binary: options.binary } : {}),
  });
  const config = testConfig();
  const mirror = options.mirror ?? new RecordingMirror();
  const workspace = new VercelWorkspace({
    sandbox: sandbox as unknown as Sandbox,
    projectId: "proj-1",
    workspacePath: config.workspacePath,
    execTimeoutMs: config.execTimeoutMs,
    devServerReadyTimeoutMs: config.devServerReadyTimeoutMs,
    mirror,
  });
  return { workspace, sandbox, mirror };
}

const execCommands = (sandbox: FakeSandbox) => sandbox.calls.exec.map((call) => call.argv.join(" "));

describe("exec is the metered path", () => {
  it("runs the agent's shell string through bash and reports the result", async () => {
    const { workspace, sandbox } = workspaceFor();
    const result = await workspace.exec("npm test -- src", { cwd: "/workspace", timeoutMs: 5_000 });

    expect(sandbox.calls.exec).toHaveLength(1);
    expect(sandbox.calls.exec[0]?.argv).toEqual(["/bin/bash", "-lc", "npm test -- src"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("marks the mirror dirty, because a command can write files no one reported", async () => {
    const { workspace, mirror } = workspaceFor();
    await workspace.exec("touch /workspace/new.ts");
    expect(mirror.dirtyCalls).toEqual(["proj-1"]);
  });

  it("reports a command that used all its deadline and failed as a timeout", async () => {
    const { workspace } = workspaceFor({
      handlers: [
        {
          match: (argv) => argv.join(" ").includes("sleep"),
          result: { exitCode: 124, stderr: "killed" },
          delayMs: 40,
        },
      ],
    });
    const result = await workspace.exec("sleep 999", { timeoutMs: 20 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("does not relabel an ordinary failure as a timeout", async () => {
    const { workspace } = workspaceFor({
      handlers: [{ match: (argv) => argv.join(" ").includes("npm"), result: { exitCode: 1, stderr: "1 test failed" } }],
    });
    const result = await workspace.exec("npm test", { timeoutMs: 20_000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

describe("file reads and writes cost no commands", () => {
  it("reads through the transfer API, never a shell", async () => {
    const { workspace, sandbox } = workspaceFor({ files: { [A]: "alpha" } });
    expect(await workspace.readFile(A)).toBe("alpha");
    expect(execCommands(sandbox)).toEqual([]);
    expect(sandbox.calls.reads).toEqual([A]);
  });

  it("writes a whole batch in one transfer", async () => {
    const { workspace, sandbox } = workspaceFor();
    await workspace.applyFileMutations([
      { path: A, content: "one", expectCurrent: null },
      { path: B, content: "two", expectCurrent: null },
    ]);
    expect(sandbox.calls.writes).toHaveLength(1);
    expect(sandbox.calls.writes[0]).toEqual([A, B]);
  });

  it("flags non-round-trippable bytes as binary rather than guessing", async () => {
    // 0xFF 0xFE is not valid UTF-8: decoding and re-encoding cannot give these
    // bytes back, which is exactly why undo must refuse to store such a file.
    const { workspace, sandbox } = workspaceFor({ binary: { "/workspace/bin.png": new Uint8Array([0xff, 0xfe, 0x00, 0x41]) } });
    const batch = await workspace.readFilesBatch(["/workspace/bin.png"]);
    expect(batch["/workspace/bin.png"]?.exists).toBe(true);
    expect(batch["/workspace/bin.png"]).toHaveProperty("isText", false);
    expect(batch["/workspace/bin.png"]).toHaveProperty("content", null);
    expect(sandbox.calls.exec).toEqual([]);
  });
});

describe("applyFileMutations keeps undo's compare-and-swap", () => {
  it("refuses to clobber a file that changed since the checkpoint", async () => {
    const { workspace, sandbox } = workspaceFor({ files: { [A]: "user edited this" } });
    const results = await workspace.applyFileMutations([{ path: A, content: "agent version", expectCurrent: "original" }]);

    expect(results[0]?.status).toBe("conflict");
    expect(results[0]?.detail).toBe("content changed since the checkpoint");
    expect(sandbox.contentOf(A)).toBe("user edited this");
    expect(sandbox.calls.writes).toHaveLength(0);
  });

  it("treats a nil expectCurrent as 'must not already exist'", async () => {
    const { workspace } = workspaceFor({ files: { [A]: "already here" } });
    const results = await workspace.applyFileMutations([{ path: A, content: "new file", expectCurrent: null }]);
    expect(results[0]?.status).toBe("conflict");
    expect(results[0]?.detail).toBe("file exists but the checkpoint recorded it as absent");
  });

  it("applies two edits to one path in a single batch, chained", async () => {
    const { workspace, sandbox } = workspaceFor({ files: { [A]: "one two" } });
    const results = await workspace.applyFileMutations([
      { path: A, content: "1 two", expectCurrent: "one two" },
      { path: A, content: "1 2", expectCurrent: "1 two" },
    ]);

    expect(results.map((result) => result.status)).toEqual(["restored", "restored"]);
    expect(sandbox.contentOf(A)).toBe("1 2");
  });

  it("deletes everything in one command", async () => {
    const { workspace, sandbox } = workspaceFor({ files: { [A]: "a", [B]: "b", [C]: "c" } });
    const results = await workspace.applyFileMutations([
      { path: A, content: null, expectCurrent: "a" },
      { path: B, content: null, expectCurrent: "b" },
      { path: C, content: null, expectCurrent: "c" },
    ]);

    expect(results.every((result) => result.status === "deleted")).toBe(true);
    const deletes = sandbox.calls.exec.filter((call) => call.argv[0] === "/bin/rm");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.argv).toEqual(["/bin/rm", "-rf", "--", A, B, C]);
    expect(sandbox.contentOf(A)).toBeUndefined();
  });
});

describe("preview URLs say what they are", () => {
  it("returns the host with a null token, meaning nobody authenticates it", async () => {
    const { workspace } = workspaceFor();
    const preview = await workspace.getPreviewUrl(3000);
    expect(preview.url).toBe("https://dai-test-3000.vercel.run");
    expect(preview.token).toBeNull();
  });

  it("reports no preview instead of throwing when the port has no route", async () => {
    const sandbox = new FakeSandbox({ domainError: true });
    const config = testConfig();
    const workspace = new VercelWorkspace({
      sandbox: sandbox as unknown as Sandbox,
      projectId: "proj-1",
      workspacePath: config.workspacePath,
      execTimeoutMs: config.execTimeoutMs,
      devServerReadyTimeoutMs: config.devServerReadyTimeoutMs,
    });
    expect(await workspace.getPreviewUrl(4000)).toEqual({ url: null, token: null });
  });
});

describe("directory operations", () => {
  it("lists one level with full paths", async () => {
    const { workspace } = workspaceFor({ files: { [A]: "a", [B]: "b", "/workspace/other/c.ts": "c" } });
    const entries = await workspace.listFiles("/workspace");
    expect(entries.map((entry) => entry.name).sort()).toEqual(["other", "src"]);
    const src = entries.find((entry) => entry.name === "src");
    expect(src?.path).toBe("/workspace/src");
    expect(src?.kind).toBe("directory");
  });

  it("returns an empty listing for a missing directory rather than throwing", async () => {
    const { workspace } = workspaceFor();
    expect(await workspace.listFiles("/workspace/nope")).toEqual([]);
  });

  it("renames and removes in place", async () => {
    const { workspace, sandbox } = workspaceFor({ files: { [A]: "alpha" }, directories: ["/workspace", "/workspace/src"] });
    await workspace.rename(A, "/workspace/src/z.ts");
    expect(sandbox.contentOf("/workspace/src/z.ts")).toBe("alpha");
    await workspace.remove("/workspace/src/z.ts");
    expect(sandbox.contentOf("/workspace/src/z.ts")).toBeUndefined();
  });
});

describe("name and content search are commands, not file API calls", () => {
  it("searches with one find, not a walk of readdir", async () => {
    const { workspace, sandbox } = workspaceFor({
      files: { [A]: "a", "/workspace/node_modules/leftpad/index.ts": "dep" },
      handlers: [
        {
          match: (argv) => argv.join(" ").includes("find"),
          result: { exitCode: 0, stdout: "/workspace/src/a.ts\n" },
        },
      ],
    });
    expect(await workspace.searchFiles("/workspace", "*.ts")).toEqual(["/workspace/src/a.ts"]);
    const argv = execCommands(sandbox).filter((line) => line.includes("find"));
    // A readdir walk would look like one `find -maxdepth 1` per directory,
    // because the SDK implements readdir with find; one call is the point.
    expect(argv).toHaveLength(1);
    expect(argv[0]).toContain("-maxdepth");
  });

  it("bounds a search at 200 paths", async () => {
    const stdout = Array.from({ length: 250 }, (_, index) => `/workspace/f${index}.ts`).join("\n");
    const { workspace } = workspaceFor({
      files: { [A]: "a" },
      handlers: [{ match: (argv) => argv.join(" ").includes("find"), result: { exitCode: 0, stdout } }],
    });
    expect(await workspace.searchFiles("/workspace", "*.ts")).toHaveLength(200);
  });

  it("greps contents with one command and parses path, line and text", async () => {
    const { workspace, sandbox } = workspaceFor({
      files: { [A]: "a" },
      handlers: [
        {
          match: (argv) => argv.join(" ").includes("grep"),
          result: { exitCode: 0, stdout: `${A}:7:const answer = 42` },
        },
      ],
    });
    expect(await workspace.searchContent("/workspace", "answer")).toEqual([
      { path: A, line: 7, content: "const answer = 42" },
    ]);
    expect(execCommands(sandbox).filter((line) => line.includes("grep"))).toHaveLength(1);
  });
});
