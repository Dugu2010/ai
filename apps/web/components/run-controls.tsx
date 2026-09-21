"use client";

/**
 * Run controls.
 *
 * Enabled strictly by the `/status` flags, so a button that would do nothing on
 * the server is never offered. Continue and Retry differently send a follow-up
 * instruction to the same conversation — the contract has no other resume verb.
 */

import { CirclePause, RefreshCw, Undo2 } from "lucide-react";
import type { RunFlags } from "@/lib/use-agent-run";
import { TextButton } from "./panel";

export interface RunControlsProps {
  flags: RunFlags;
  live: boolean;
  streaming: boolean;
  hasRun: boolean;
  onContinue: () => void;
  onRetryDifferently: () => void;
  onStop: () => void;
  onUndo?: () => void;
  /** The choices the backend offered when it paused, e.g. ["continue", …]. */
  pauseChoices?: string[];
}

export function RunControls({
  flags,
  live,
  streaming,
  hasRun,
  onContinue,
  onRetryDifferently,
  onStop,
  onUndo,
  pauseChoices,
}: RunControlsProps) {
  const offered = pauseChoices ?? [];
  const wants = (choice: string) => offered.length === 0 || offered.includes(choice);
  const showContinue = !streaming && flags.canContinue && wants("continue");
  const showRetry = !streaming && flags.canRetryDifferently && wants("retry-differently");
  const showUndo = Boolean(onUndo) && wants("undo");
  const showStop = live && hasRun;

  if (!showContinue && !showRetry && !showStop && !showUndo) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 pl-4">
      {showStop ? (
        <TextButton variant="danger" onClick={onStop} title="Stop after the current step. Files and checkpoints are kept.">
          <CirclePause size={14} aria-hidden="true" />
          Stop
        </TextButton>
      ) : null}
      {showContinue ? (
        <TextButton variant="secondary" onClick={onContinue} title="Send the agent a follow-up: continue where it stopped.">
          Continue
        </TextButton>
      ) : null}
      {showRetry ? (
        <TextButton
          variant="secondary"
          onClick={onRetryDifferently}
          title="Send the agent a follow-up asking for a materially different approach."
        >
          <RefreshCw size={14} aria-hidden="true" />
          Retry differently
        </TextButton>
      ) : null}
      {showUndo && onUndo ? (
        <TextButton variant="ghost" onClick={onUndo} title="Open the Changes panel to revert this run.">
          <Undo2 size={14} aria-hidden="true" />
          Review changes
        </TextButton>
      ) : null}
    </div>
  );
}
