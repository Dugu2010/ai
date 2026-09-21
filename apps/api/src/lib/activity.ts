/**
 * Agent activity model.
 *
 * Two rules govern everything here:
 *
 * 1. NO CHAIN OF THOUGHT. Titles describe what was done and what happened —
 *    observable facts — never the model's internal reasoning. The prompt sent to
 *    NIM is never persisted or streamed through this channel.
 *
 * 2. NO SYNTHESISED PROGRESS. Every event originates from a real transition:
 *    an acquired Sandbox, a completed command, a parsed test summary, a written
 *    file. Nothing is emitted on a timer and no animation stands in for work.
 */

import type {
  ActivityEvent,
  ActivityEventDetail,
  ActivityEventType,
  AgentState,
} from "@dai/types";

export type { ActivityEvent, ActivityEventDetail, ActivityEventType, AgentState };

/**
 * Ordered for the UI's progress rail. Not every state appears in every run:
 * a read-only task never reaches `executing`, and a run that degrades on budget
 * never pretends to have `previewing`ed.
 */
export const AGENT_STATES: readonly AgentState[] = [
  "queued","thinking","inspecting","searching","reading","planning","editing","executing",
  "testing","building","diagnosing","fixing","verifying","previewing","completed","failed","waiting","paused",
];

export const TERMINAL_STATES: readonly AgentState[] = ["completed", "failed", "paused"];

/** Signature of the emitter handed to the agent loop and every tool helper. */
export interface Emitter {
  (
    type: ActivityEventType,
    title: string,
    detail?: ActivityEventDetail,
    state?: AgentState
  ): ActivityEvent;
}

/** How the loop reports one activity. `state` advances the visible agent state. */
export interface Emitter {
  (
    type: ActivityEventType,
    title: string,
    detail?: ActivityEventDetail,
    state?: AgentState
  ): ActivityEvent;
}

/**
 * Sequences and fans out events. Persists before publishing so a reload
 * reconstructs exactly the timeline the user watched.
 *
 * `id` is a placeholder here and is assigned by the store on insert; the browser
 * orders strictly by `seq`, which the emitter owns.
 */
export function createActivityEmitter(input: {
  runId: string;
  projectId: string;
  persist: (event: ActivityEvent) => void;
  publish: (frame: ActivityEvent) => void;
}): { emit: Emitter; events: ActivityEvent[] } {
  let seq = 0;
  const events: ActivityEvent[] = [];
  return {
    events,
    emit(type, title, detail = {}, state) {
      const event: ActivityEvent = {
        id: 0,
        runId: input.runId,
        seq: ++seq,
        type,
        state: state ?? null,
        title,
        detail,
        createdAt: new Date().toISOString(),
      };
      events.push(event);
      input.persist(event);
      input.publish(event);
      return event;
    },
  };
}

export type CommandKind = "test" | "build" | "install" | "verify" | "server" | "git" | "other";

const KIND_PATTERNS: Array<{ kind: CommandKind; re: RegExp; title: string }> = [
  { kind: "test", re: /\b(vitest|jest|mocha|pytest|npm (run )?test|bun (run )?test|pnpm test|yarn test)\b/, title: "Running tests" },
  { kind: "build", re: /\b(npm run build|bun run build|pnpm build|yarn build|tsc -b|webpack|rollup|vite build|esbuild)\b/, title: "Building the project" },
  { kind: "install", re: /\b(npm|pnpm|yarn|bun|pip3?|poetry)\s+(install|add|ci)\b/, title: "Installing dependencies" },
  { kind: "verify", re: /\b(tsc\b|typecheck|eslint|lint|prettier --check)\b/, title: "Running TypeScript verification" },
  { kind: "server", re: /\b(npm run dev|bun run dev|pnpm dev|yarn dev|vite|next dev|node .*server)\b/, title: "Starting the dev server" },
  { kind: "git", re: /^\s*git\s/, title: "Inspecting git state" },
];

/**
 * Classify a command for display. The title is derived from the command text
 * itself, so "Running TypeScript verification" only appears for a command that
 * actually invokes the type checker.
 */
export function classifyCommand(command: string): { kind: CommandKind; title: string } {
  for (const entry of KIND_PATTERNS) {
    if (entry.re.test(command)) return { kind: entry.kind, title: entry.title };
  }
  const head = command.trim().split(/\s+/).slice(0, 2).join(" ");
  return { kind: "other", title: head ? `Running ${head}` : "Running a command" };
}

const FAILURE_PATTERNS: RegExp[] = [
  /(\d+)\s+(?:test\s+)?failures?/i,
  /failed\s*\(\s*(\d+)/i,
  /(\d+)\s+failed/i,
  /Tests:\s+.*?(\d+)\s+failed/i,
  /(\d+)\s+error/i,
];

/** Pull real failure counts out of test output. Returns null when none are stated. */
export function parseFailureCount(output: string): number | null {
  for (const pattern of FAILURE_PATTERNS) {
    const match = pattern.exec(output);
    if (match?.[1]) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count) && count > 0) return count;
    }
  }
  return null;
}

/** Collapse whitespace and strip absolute paths so fingerprints compare fairly. */
export function normalizeForFingerprint(value: string): string {
  return value.replace(/\/workspace\//g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A stable error signature: exit code plus the first distinct error lines, with
 * line numbers and paths stripped. Recurring failures then compare equal even
 * when surrounding output differs.
 */
export function errorSignature(text: string, exitCode: number | null): string {
  const lines = normalizeForFingerprint(text)
    .split("\n")
    .filter((line) => line.includes("error") || line.includes("fail"))
    .slice(0, 4);
  const stripped = lines.map((line) => line.replace(/:\d+:\d+/g, "").replace(/\d+/g, "N")).join("|");
  return `exit:${exitCode ?? "?"}::${stripped.slice(0, 300)}`;
}
