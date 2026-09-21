/**
 * Stuck-agent detection.
 *
 * A loop is not "many tool calls" — it is repetition without progress. The
 * signal that matters is whether the workspace actually changed between attempts,
 * so an agent legitimately running `npm test` four times while it fixes real
 * failures is not flagged, and an agent running the same command against an
 * unchanged tree is.
 */

import { normalizeForFingerprint } from "./activity.js";

export interface LoopObservation {
  /** Tool name plus its arguments, folded to a comparable key. */
  callKey: string;
  /** For commands: the command text; for edits: the target path. */
  subject?: string;
  errorSignature?: string;
  /** Number of workspace files this step changed (0 = nothing happened). */
  filesChanged: number;
  /** Character delta across changed files, sign ignored. */
  changedBytes: number;
}

export interface LoopVerdict {
  looping: boolean;
  kind: "identical_call" | "repeated_failure" | "no_progress" | "thrashing" | null;
  /** High-level, user-facing. Names the pattern, not hidden reasoning. */
  summary: string;
  /** Safe alternative to attempt before pausing, when one exists. */
  suggestedStrategy: string | null;
  shouldPause: boolean;
}

export interface LoopDetectorOptions {
  /** Same exact call this many times is a loop. */
  repeatThreshold?: number;
  /** Same error signature this many times is a loop. */
  failureThreshold?: number;
  /** Consecutive steps with no workspace change before flagging. */
  stagnationThreshold?: number;
  /** A/B/A file edits across this many steps counts as thrashing. */
  thrashWindow?: number;
  /** After this many detections the run pauses instead of trying again. */
  maxRecoveries?: number;
}

const DEFAULTS: Required<LoopDetectorOptions> = {
  repeatThreshold: 3,
  failureThreshold: 3,
  stagnationThreshold: 4,
  thrashWindow: 6,
  maxRecoveries: 1,
};

export function callKey(name: string, args: Record<string, unknown>): string {
  const significant = Object.keys(args)
    .sort()
    .map((key) => `${key}=${normalizeForFingerprint(String(args[key] ?? "")).slice(0, 160)}`)
    .join("&");
  return `${name}::${significant}`;
}

export class LoopDetector {
  private readonly limits: Required<LoopDetectorOptions>;
  private readonly observations: LoopObservation[] = [];
  recoveries = 0;

  constructor(options: LoopDetectorOptions = {}) {
    this.limits = { ...DEFAULTS, ...options };
  }

  get size(): number {
    return this.observations.length;
  }

  record(observation: LoopObservation): void {
    this.observations.push(observation);
  }

  /**
   * Evaluate the recent window. Checked in order of confidence: an exactly
   * repeated call is the strongest signal, then an unchanging error, then
   * edit thrashing, then general stagnation.
   */
  assess(): LoopVerdict {
    const none: LoopVerdict = {
      looping: false,
      kind: null,
      summary: "",
      suggestedStrategy: null,
      shouldPause: false,
    };
    if (this.observations.length === 0) return none;

    const recent = this.observations.slice(-this.limits.repeatThreshold);
    if (
      recent.length === this.limits.repeatThreshold &&
      recent.every((entry) => entry.callKey === recent[0]!.callKey)
    ) {
      return this.emit(
        "identical_call",
        `The agent repeated the same ${recent[0]!.callKey.split("::")[0]} call ${this.limits.repeatThreshold} times with no change in state.`,
        "Try a different approach: inspect the failing file directly instead of re-running the same step."
      );
    }

    const failures = this.observations
      .slice(-this.limits.failureThreshold)
      .filter((entry) => entry.errorSignature);
    if (
      failures.length === this.limits.failureThreshold &&
      failures.every((entry) => entry.errorSignature === failures[0]!.errorSignature)
    ) {
      return this.emit(
        "repeated_failure",
        "The same failure has now recurred three times, so repeating it will not resolve it.",
        "Re-read the source of the error and change the fix rather than the retry."
      );
    }

    const window = this.observations.slice(-this.limits.thrashWindow).map((entry) => entry.subject);
    const touched = window.filter((value): value is string => Boolean(value));
    if (touched.length >= 4 && isThrashing(touched)) {
      return this.emit(
        "thrashing",
        `The agent is alternating edits on the same file (${touched[touched.length - 1]}), undoing its own changes.`,
        "Restore the last known-good state and apply one complete change."
      );
    }

    const stagnant = this.observations.slice(-this.limits.stagnationThreshold);
    if (
      stagnant.length === this.limits.stagnationThreshold &&
      stagnant.every((entry) => entry.filesChanged === 0 && entry.changedBytes === 0)
    ) {
      return this.emit(
        "no_progress",
        `No file changes have been produced across the last ${this.limits.stagnationThreshold} steps.`,
        null
      );
    }

    return none;
  }

  private emit(kind: LoopVerdict["kind"], summary: string, suggestedStrategy: string | null): LoopVerdict {
    this.recoveries += 1;
    // First detection gets one bounded retry with a changed strategy; a repeat
    // means the alternative did not help, so the user decides.
    const shouldPause = this.recoveries > this.limits.maxRecoveries || suggestedStrategy === null;
    return { looping: true, kind, summary, suggestedStrategy, shouldPause };
  }

  /** Called when the alternative strategy actually helped. */
  noteProgress(): void {
    this.recoveries = 0;
  }
}

/** A touched like X,Y,X,Y or X,Y,Z,X,Y — the same file revisited after moving on. */
function isThrashing(subjects: string[]): boolean {
  const tail = subjects.slice(-4);
  if (tail.length < 4) return false;
  const [a, b, c, d] = tail as [string, string, string, string];
  if (a === c && b === d && a !== b) return true;
  return a === d && a !== b && a !== c;
}
