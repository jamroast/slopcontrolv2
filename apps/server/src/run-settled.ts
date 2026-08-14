import { isTerminalRunStage, type RunStage } from "@slopcontrol/types";

/**
 * Choke-point rule for run-settled push notifications: notify only on a real
 * transition INTO a terminal stage. Gate stages (in_review) belong to the
 * chat follow-up watcher, and re-touching the same stage must not re-notify.
 */
export function shouldNotifyRunSettled(previous: RunStage, next: RunStage): boolean {
  return previous !== next && isTerminalRunStage(next);
}
