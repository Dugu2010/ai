import { describe, expect, it } from "vitest";
import { LoopDetector, callKey, type LoopObservation } from "../src/lib/loop-detector.js";

/** Shorthand so each scenario reads as a sequence of steps. */
function step(overrides: Partial<LoopObservation> & { callKey: string }): LoopObservation {
  return { filesChanged: 0, changedBytes: 0, ...overrides };
}

function recordAll(detector: LoopDetector, observations: LoopObservation[]): void {
  for (const observation of observations) detector.record(observation);
}

/** Feed one step and return the verdict after it, as the loop would. */
function feed(detector: LoopDetector, observation: LoopObservation) {
  detector.record(observation);
  return detector.assess();
}

const READ = (path: string) => step({ callKey: `read_file::path=${path}` });
const TEST = () => step({ callKey: "run_tests::" });
const EDIT = (path: string, filesChanged = 1) =>
  step({ callKey: `edit_file::path=${path}`, subject: path, filesChanged, changedBytes: 40 });

describe("callKey", () => {
  it("folds argument order but not argument values", () => {
    expect(callKey("read_file", { path: "/workspace/a.ts", dir: "/workspace" })).toBe(
      callKey("read_file", { dir: "/workspace", path: "/workspace/a.ts" })
    );
    expect(callKey("read_file", { path: "/workspace/a.ts" })).not.toBe(
      callKey("read_file", { path: "/workspace/b.ts" })
    );
  });

  it("separates tools that share arguments", () => {
    expect(callKey("write_file", { path: "/workspace/a.ts" })).not.toBe(
      callKey("read_file", { path: "/workspace/a.ts" })
    );
  });

  it("folds the workspace prefix away, because this is a fingerprint not a guard", () => {
    expect(callKey("read_file", { path: "/workspace/src/a.ts" })).toBe(callKey("read_file", { path: "src/a.ts" }));
  });

  it("bounds the key so a huge argument cannot grow the history", () => {
    const key = callKey("write_file", { content: "x".repeat(10_000) });
    expect(key.length).toBeLessThan(200);
  });

  it("collapses argument whitespace so reformatting cannot hide a repeat", () => {
    expect(callKey("run_command", { command: "npm   test" })).toBe(callKey("run_command", { command: "npm test" }));
    expect(callKey("run_command", { command: " npm test \n" })).toBe(callKey("run_command", { command: "npm test" }));
  });

  it("still distinguishes an omitted argument from an empty one", () => {
    // Pinned behaviour: the key names every argument that is present, so a model
    // that alternates between `run_tests` and `run_tests{filter:""}` is not seen
    // as repeating. Benign — the stagnation and failure detectors cover it.
    expect(callKey("run_tests", { filter: "" })).not.toBe(callKey("run_tests", {}));
  });
});

describe("identical_call", () => {
  it("fires on three identical calls", () => {
    const detector = new LoopDetector();
    recordAll(detector, [READ("/workspace/a.ts"), READ("/workspace/a.ts"), READ("/workspace/a.ts")]);
    const verdict = detector.assess();
    expect(verdict.looping).toBe(true);
    expect(verdict.kind).toBe("identical_call");
    expect(verdict.summary).toMatch(/repeated the same read_file call 3 times/);
    expect(verdict.suggestedStrategy).toMatch(/different approach/);
  });

  it("stays quiet on two", () => {
    const detector = new LoopDetector();
    recordAll(detector, [READ("/workspace/a.ts"), READ("/workspace/a.ts")]);
    expect(detector.assess().looping).toBe(false);
  });

  it("honours a configured repeat threshold", () => {
    const detector = new LoopDetector({ repeatThreshold: 2, stagnationThreshold: 9, thrashWindow: 20 });
    recordAll(detector, [READ("/workspace/a.ts"), READ("/workspace/a.ts")]);
    expect(detector.assess().kind).toBe("identical_call");
  });
});

describe("repeated_failure", () => {
  const signature = "exit:1::cannot find module 'x'";

  it("fires when the same error recurs across different calls", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      step({ callKey: "run_command::command=npm test", errorSignature: signature }),
      step({ callKey: "run_command::command=npm run build", errorSignature: signature }),
      step({ callKey: "run_command::command=node index.js", errorSignature: signature }),
    ]);
    const verdict = detector.assess();
    expect(verdict.kind).toBe("repeated_failure");
    expect(verdict.summary).toMatch(/recurred three times/);
  });

  it("does not fire when each attempt fails differently", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      step({ callKey: "run_command::command=a", errorSignature: "exit:1::first" }),
      step({ callKey: "run_command::command=b", errorSignature: "exit:1::second" }),
      step({ callKey: "run_command::command=c", errorSignature: "exit:1::third" }),
    ]);
    expect(detector.assess().kind).not.toBe("repeated_failure");
  });

  it("requires every recent step to carry the failure", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      step({ callKey: "run_command::command=a", errorSignature: signature }),
      READ("/workspace/a.ts"),
      step({ callKey: "run_command::command=b", errorSignature: signature }),
    ]);
    expect(detector.assess().kind).not.toBe("repeated_failure");
  });
});

describe("thrashing", () => {
  it("fires on an A/B/A/B edit pattern on the same files", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      EDIT("/workspace/a.ts"),
      EDIT("/workspace/b.ts"),
      EDIT("/workspace/a.ts"),
      EDIT("/workspace/b.ts"),
    ]);
    const verdict = detector.assess();
    expect(verdict.kind).toBe("thrashing");
    expect(verdict.summary).toMatch(/alternating edits/);
  });

  it("fires on A/B/C/A, a file revisited after moving on", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      EDIT("/workspace/a.ts"),
      EDIT("/workspace/b.ts"),
      EDIT("/workspace/c.ts"),
      EDIT("/workspace/a.ts"),
    ]);
    expect(detector.assess().kind).toBe("thrashing");
  });

  it("ignores steps that touched no file", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      EDIT("/workspace/a.ts"),
      TEST(),
      EDIT("/workspace/a.ts"),
      TEST(),
    ]);
    // Only two subjects are in the window, below the four required.
    expect(detector.assess().kind).not.toBe("thrashing");
  });
});

describe("no_progress", () => {
  it("fires after four consecutive steps that changed nothing", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      READ("/workspace/a.ts"),
      step({ callKey: "list_files::path=/workspace" }),
      step({ callKey: "run_command::command=ls" }),
      READ("/workspace/b.ts"),
    ]);
    const verdict = detector.assess();
    expect(verdict.kind).toBe("no_progress");
    expect(verdict.summary).toMatch(/No file changes/);
    // With no alternative to offer, the user decides immediately.
    expect(verdict.suggestedStrategy).toBeNull();
    expect(verdict.shouldPause).toBe(true);
  });

  it("is not flagged while a step below the threshold is still recent", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      EDIT("/workspace/a.ts"),
      READ("/workspace/a.ts"),
      READ("/workspace/b.ts"),
      READ("/workspace/c.ts"),
    ]);
    expect(detector.assess().kind).toBeNull();
  });

  it("counts bytes changed, not just file count", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      step({ callKey: "a", filesChanged: 0, changedBytes: 12 }),
      step({ callKey: "b", filesChanged: 0, changedBytes: 12 }),
      step({ callKey: "c", filesChanged: 0, changedBytes: 12 }),
      step({ callKey: "d", filesChanged: 0, changedBytes: 12 }),
    ]);
    expect(detector.assess().kind).toBeNull();
  });
});

describe("an agent that is actually making progress", () => {
  /**
   * The most important behaviour in this file: rerunning the same test command
   * while editing files in between is what fixing a bug looks like. Flagging it
   * would pause healthy runs and is the failure mode this detector exists to
   * avoid.
   */
  it("never flags edit-then-test while the workspace keeps changing", () => {
    const detector = new LoopDetector();
    const failures = ["exit:1::a failed", "exit:1::b failed", "exit:1::c failed", "exit:1::d failed"];
    let detected: string[] = [];

    for (let round = 0; round < 8; round += 1) {
      const path = `/workspace/src/feature${round}.ts`;
      detected.push(
        String(
          feed(detector, {
            callKey: `edit_file::path=${path}`,
            subject: path,
            filesChanged: 1,
            changedBytes: 120 + round,
          }).kind
        )
      );
      detected.push(
        String(
          feed(detector, {
            callKey: "run_tests::",
            errorSignature: failures[round % failures.length],
            filesChanged: 1,
            changedBytes: 120 + round,
          }).kind
        )
      );
    }

    expect(detected.filter((kind) => kind !== "null")).toEqual([]);
  });

  it("does not flag a build that keeps failing differently after each edit", () => {
    const detector = new LoopDetector();
    const sequence: LoopObservation[] = [
      EDIT("/workspace/a.ts"),
      step({ callKey: "run_command::command=npm run build", errorSignature: "exit:1::one" }),
      EDIT("/workspace/b.ts"),
      step({ callKey: "run_command::command=npm run build", errorSignature: "exit:1::two" }),
      EDIT("/workspace/c.ts"),
      step({ callKey: "run_command::command=npm run build", errorSignature: "exit:1::three" }),
    ];
    for (const observation of sequence) {
      detector.record(observation);
      expect(detector.assess().looping, observation.callKey).toBe(false);
    }
  });

  it("treats a read of the same file twice as legitimate", () => {
    const detector = new LoopDetector();
    recordAll(detector, [
      READ("/workspace/a.ts"),
      EDIT("/workspace/a.ts"),
      READ("/workspace/a.ts"),
    ]);
    expect(detector.assess().looping).toBe(false);
  });
});

describe("recovery and pausing", () => {
  it("offers one bounded retry before pausing", () => {
    const detector = new LoopDetector();
    recordAll(detector, [READ("/workspace/a.ts"), READ("/workspace/a.ts"), READ("/workspace/a.ts")]);
    const first = detector.assess();
    expect(first.shouldPause).toBe(false);
    expect(detector.recoveries).toBe(1);
    // Same state, so the next assessment repeats the detection: the alternative
    // did not help, and the run must stop for the user to decide.
    const second = detector.assess();
    expect(second.shouldPause).toBe(true);
    expect(detector.recoveries).toBe(2);
  });

  it("clears the recovery credit once progress is recorded", () => {
    const detector = new LoopDetector();
    recordAll(detector, [READ("/workspace/a.ts"), READ("/workspace/a.ts"), READ("/workspace/a.ts")]);
    expect(detector.assess().shouldPause).toBe(false);
    detector.noteProgress();
    expect(detector.recoveries).toBe(0);
    recordAll(detector, [
      EDIT("/workspace/a.ts"),
      READ("/workspace/a.ts"),
      READ("/workspace/a.ts"),
      READ("/workspace/a.ts"),
    ]);
    // A fresh detection after real progress gets its own bounded retry.
    expect(detector.assess().shouldPause).toBe(false);
    expect(detector.recoveries).toBe(1);
  });

  it("pauses immediately once maxRecoveries is exhausted", () => {
    const detector = new LoopDetector({ maxRecoveries: 0 });
    recordAll(detector, [READ("/workspace/a.ts"), READ("/workspace/a.ts"), READ("/workspace/a.ts")]);
    expect(detector.assess().shouldPause).toBe(true);
  });

  it("records nothing as an empty history and returns a clean verdict", () => {
    const detector = new LoopDetector();
    expect(detector.size).toBe(0);
    expect(detector.assess()).toEqual({
      looping: false,
      kind: null,
      summary: "",
      suggestedStrategy: null,
      shouldPause: false,
    });
  });

  it("keeps counting steps it is given", () => {
    const detector = new LoopDetector();
    recordAll(detector, [READ("/workspace/a.ts"), READ("/workspace/b.ts")]);
    expect(detector.size).toBe(2);
  });
});
