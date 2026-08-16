import {
  isGateRunStage,
  isTerminalRunStage,
  type RunStage,
} from "@slopcontrol/types";

/**
 * Choke-point rule for run-settled push notifications: notify only on a real
 * transition INTO a terminal stage. Re-touching the same stage must not
 * re-notify.
 */
export function shouldNotifyRunSettled(previous: RunStage, next: RunStage): boolean {
  return previous !== next && isTerminalRunStage(next);
}

/** Mid-pipeline handoffs (in_review, accepted, design_complete). */
export function shouldNotifyRunGate(previous: RunStage, next: RunStage): boolean {
  return previous !== next && isGateRunStage(next);
}

/** Any non-busy handoff worth pushing to awaiting chat conversations. */
export function shouldNotifyRunStageChange(
  previous: RunStage,
  next: RunStage,
): boolean {
  return shouldNotifyRunSettled(previous, next) || shouldNotifyRunGate(previous, next);
}
