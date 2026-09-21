import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  createActivityEmitter,
  errorSignature,
  normalizeForFingerprint,
  parseFailureCount,
} from "../src/lib/activity.js";

describe("activity emitter", () => {
  it("numbers events from 1 and never repeats a seq", () => {
    const { emit, events } = createActivityEmitter({
      runId: "run-9",
      projectId: "p1",
      persist: () => undefined,
      publish: () => undefined,
    });
    emit("agent.started", "Task accepted");
    emit("agent.status", "Deciding what to do next", {}, "thinking");
    emit("agent.command.completed", "Tests passed");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("persists before publishing, so a reload cannot miss what was streamed", () => {
    const order: string[] = [];
    const { emit } = createActivityEmitter({
      runId: "run-9",
      projectId: "p1",
      persist: () => order.push("persist"),
      publish: () => order.push("publish"),
    });
    emit("agent.started", "Task accepted");
    expect(order).toEqual(["persist", "publish"]);
  });

  it("hands the identical event object to both sinks, stamped with the run id", () => {
    const persisted: unknown[] = [];
    const published: unknown[] = [];
    const { emit } = createActivityEmitter({
      runId: "run-42",
      projectId: "p1",
      persist: (event) => persisted.push(event),
      publish: (event) => published.push(event),
    });
    const returned = emit("agent.status", "Working", { command: "npm test" }, "executing");
    expect(persisted[0]).toBe(returned);
    expect(published[0]).toBe(returned);
    expect(returned.runId).toBe("run-42");
    expect(returned.detail).toEqual({ command: "npm test" });
    expect(returned.state).toBe("executing");
  });

  it("defaults the detail to an empty object and the state to null", () => {
    const { emit } = createActivityEmitter({
      runId: "r",
      projectId: "p",
      persist: () => undefined,
      publish: () => undefined,
    });
    const event = emit("agent.started", "Task accepted");
    expect(event.detail).toEqual({});
    expect(event.state).toBeNull();
  });

  it("leaves id assignment to the store and stamps a wall-clock time", () => {
    const { emit } = createActivityEmitter({
      runId: "r",
      projectId: "p",
      persist: () => undefined,
      publish: () => undefined,
    });
    const event = emit("agent.started", "Task accepted");
    expect(event.id).toBe(0);
    expect(Date.parse(event.createdAt)).not.toBeNaN();
  });

  it("does not invent events between calls", () => {
    const { emit, events } = createActivityEmitter({
      runId: "r",
      projectId: "p",
      persist: () => undefined,
      publish: () => undefined,
    });
    emit("agent.started", "Task accepted");
    expect(events).toHaveLength(1);
  });
});

describe("classifyCommand", () => {
  it.each([
    ["npm test", "test"],
    ["bunx vitest run", "test"],
    ["python3 -m pytest", "test"],
    ["pnpm test", "test"],
    ["npm run build", "build"],
    ["tsc -b", "build"],
    ["npm install", "install"],
    ["pip install requests", "install"],
    ["bun add zod", "install"],
    ["tsc --noEmit", "verify"],
    ["eslint .", "verify"],
    ["npm run dev", "server"],
    ["next dev", "server"],
    ["git status", "git"],
    ["ls -la", "other"],
  ])("labels %s as %s", (command, kind) => {
    expect(classifyCommand(command).kind).toBe(kind);
  });

  it("gives each kind a title that matches what is happening", () => {
    expect(classifyCommand("npm test").title).toBe("Running tests");
    expect(classifyCommand("npm run build").title).toBe("Building the project");
    expect(classifyCommand("npm install").title).toBe("Installing dependencies");
    expect(classifyCommand("tsc --noEmit").title).toBe("Running TypeScript verification");
    expect(classifyCommand("npm run dev").title).toBe("Starting the dev server");
  });

  it("names an unclassified command by what it actually ran", () => {
    expect(classifyCommand("ls -la /workspace").title).toBe("Running ls -la");
    expect(classifyCommand("   ").title).toBe("Running a command");
  });

  it("never calls a build a test", () => {
    expect(classifyCommand("npm run build").kind).not.toBe("test");
  });
});

describe("parseFailureCount", () => {
  it.each([
    ["Tests  2 failures", 2],
    ["1 failed", 1],
    ["Tests: 12 passed, 3 failed", 3],
    ["failed (7)", 7],
    ["5 errors occurred", 5],
  ])("extracts the count from %j", (output, expected) => {
    expect(parseFailureCount(output)).toBe(expected);
  });

  it.each([
    ["All tests passed"],
    ["0 failures, 0 errors"],
    ["Test Suites: 3 passed, 3 total"],
    [""],
    ["npm ERR! code 1"],
  ])("returns null when no failure is counted: %j", (output) => {
    expect(parseFailureCount(output)).toBeNull();
  });

  it("reports the first stated count rather than summing", () => {
    expect(parseFailureCount("2 failures\n9 failures")).toBe(2);
  });
});

describe("errorSignature", () => {
  it("compares equal for the same failure at different line numbers", () => {
    const first = errorSignature("src/a.ts:12:5 TypeError: x is not a function", 1);
    const second = errorSignature("src/a.ts:99:31 TypeError: x is not a function", 1);
    expect(first).toBe(second);
  });

  it("compares equal whether or not the path is written absolutely under the workspace", () => {
    const first = errorSignature("/workspace/src/a.ts:1:1 AssertionError: boom", 1);
    const second = errorSignature("src/a.ts:1:1 AssertionError: boom", 1);
    expect(first).toBe(second);
  });

  it("separates failures with different exit codes", () => {
    expect(errorSignature("boom fail", 1)).not.toBe(errorSignature("boom fail", 2));
  });

  it("separates genuinely different failures", () => {
    expect(errorSignature("TypeError: cannot read x", 1)).not.toBe(errorSignature("ReferenceError: y is not defined", 1));
  });

  it("marks an unknown exit code instead of guessing zero", () => {
    expect(errorSignature("fail", null)).toMatch(/^exit:\?/);
  });

  it("keeps the signature bounded so it can be stored", () => {
    const long = errorSignature(`fail ${"x".repeat(5_000)}`, 1);
    expect(long.length).toBeLessThan(320);
  });

  it("reduces to the exit code when the output states no error or failure", () => {
    // Pinned limitation: the signature keeps only lines containing "error" or
    // "fail", so two different failures whose output avoids both words collapse
    // to the same string. Most real tool output says "FAIL"/"Error".
    expect(errorSignature("expected 1 to be 2", 1)).toBe(errorSignature("expected 3 to be 4", 1));
  });
});

describe("normalizeForFingerprint", () => {
  it("collapses whitespace, lowercases and drops the workspace prefix", () => {
    expect(normalizeForFingerprint("  /workspace/App.TS   exists ")).toBe("app.ts exists");
  });

  it("is stable under re-indentation", () => {
    expect(normalizeForFingerprint("a\n  b\tc")).toBe(normalizeForFingerprint("a b c"));
  });
});
