import {
  readProjectConfig,
  readRunHandoff,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  readResearchConclusionForPhase,
  readRevisionOutcome,
  summarizeRevisionOutcome,
} from "@slopcontrol/artifacts";

export type RunSettledInput = {
  id: string;
  stage: string;
  phaseId?: string;
  projectId?: string;
};

export type RunSettledContext = {
  getProject?: (id: string) => { rootPath: string } | undefined;
};

function projectRootForRun(
  run: RunSettledInput,
  ctx?: RunSettledContext,
): string | undefined {
  if (!run.projectId) return undefined;
  return ctx?.getProject?.(run.projectId)?.rootPath;
}

/**
 * Operator-facing guidance appended when a run settles (wait_for_run,
 * background watcher, or orchestrator choke-point notification).
 */
export function buildRunSettledGuidance(
  run: RunSettledInput,
  ctx?: RunSettledContext,
): string {
  if (run.stage === "in_review") {
    const rootPath = projectRootForRun(run, ctx);
    const conclusion =
      rootPath && run.phaseId
        ? readResearchConclusionForPhase(rootPath, run.phaseId)
        : "";
    const revisionOutcome =
      rootPath != null ? readRevisionOutcome(rootPath, run.id) : null;
    const diagnosis =
      rootPath != null
        ? (readDiagnosis(rootPath, run.id) ??
          (run.phaseId
            ? readLatestDiagnosisForPhase(rootPath, run.phaseId)
            : null))
        : null;
    const parts = [
      "Research is ready for operator review.",
      conclusion ? `Research conclusion: ${conclusion}` : null,
      "Park advance_run (or start_development) when they want to proceed — do not send them to a dashboard Approve button.",
      "Use submit_review request_changes only to send the plan back.",
      "Call get_run for research_conclusion if the brief was truncated.",
    ].filter(Boolean);
    if (revisionOutcome && !revisionOutcome.ok) {
      parts.push(
        `Review revision did not fully apply (${summarizeRevisionOutcome(revisionOutcome)}). Call get_run for revision_outcome and operator_suggestions — do not judge readiness from RESEARCH.md alone; read PHASE.md too.`,
      );
    } else if (revisionOutcome?.ok) {
      parts.push(
        `Review revision applied (${summarizeRevisionOutcome(revisionOutcome)}). Read both RESEARCH.md and PHASE.md before approving.`,
      );
    } else if (diagnosis?.tags?.includes("review-revision")) {
      parts.push(
        "A prior review revision left planning diagnosis on this run — call get_run for revision_outcome and operator_suggestions.",
      );
    }
    return parts.join(" ");
  }

  if (run.stage === "complete") {
    const rootPath = projectRootForRun(run, ctx);
    const config = rootPath ? readProjectConfig(rootPath) : null;
    const autoMergeEnabled = config?.autoMergeOnComplete !== false;
    const handoff = rootPath ? readRunHandoff(rootPath, run.id) : null;
    const autoMerged = handoff?.merge?.autoMerged === true;
    const worktreePresent = handoff?.merge?.worktreePresent !== false;
    const mergePending =
      handoff?.merge?.autoMerged === false && worktreePresent;

    const parts = ["Development finished successfully."];

    if (autoMerged) {
      const branch = handoff?.merge?.branch;
      const commit = handoff?.merge?.commit?.slice(0, 8);
      const target =
        branch || commit
          ? `${branch ?? "project root"}${commit ? ` @ ${commit}` : ""}`
          : "the project root";
      parts.push(
        `The phase was auto-merged into ${target}. Do NOT ask whether to merge into main or a development branch — that already happened.`,
        "Brief operator requirements and next steps instead (get_development_report if needed).",
      );
      if (handoff?.operatorRequirements?.length) {
        parts.push(
          `${handoff.operatorRequirements.length} operator follow-up note(s) recorded in the handoff.`,
        );
      }
    } else if (mergePending) {
      parts.push(
        "Auto-merge did not complete; the phase worktree may still need merge_phase when the operator explicitly asks to merge.",
      );
    } else if (autoMergeEnabled) {
      parts.push(
        "This project has autoMergeOnComplete enabled — call get_development_report to confirm merge status before offering merge_phase.",
      );
    } else {
      parts.push(
        "autoMergeOnComplete is disabled for this project. Park merge_phase only when the operator explicitly asks to merge.",
      );
    }

    return parts.join(" ");
  }

  if (run.stage === "blocked" || run.stage === "failed") {
    const rootPath = projectRootForRun(run, ctx);
    const diagnosis = rootPath
      ? (readDiagnosis(rootPath, run.id) ??
        (run.phaseId
          ? readLatestDiagnosisForPhase(rootPath, run.phaseId)
          : null))
      : null;
    const isPlanningDraft =
      diagnosis?.tags?.includes("planning") &&
      diagnosis?.tags?.includes("draft");
    if (isPlanningDraft) {
      return [
        "Planning draft failed but RESEARCH may be intact.",
        "Call retry_draft on this runId (not rerun_research unless RESEARCH.md is missing).",
        "Use get_run / get_operator_suggestions for the exact gate issues.",
      ].join(" ");
    }
    return "The run did not succeed. Use get_run / get_development_report / get_operator_suggestions for why, then propose next steps.";
  }

  return "Brief the operator on this outcome now. Do not claim the work is still in progress.";
}

/** Bracketed system notification queued for a synthetic chat turn. */
export function buildRunSettledNotification(
  run: RunSettledInput,
  ctx?: RunSettledContext,
): string {
  return `[Run ${run.id} reached ${run.stage}. ${buildRunSettledGuidance(run, ctx)}]`;
}

/** Operator-facing brief for memory + SSE (no LLM re-synthesis). */
export function formatRunNotificationBrief(note: string): string {
  const trimmed = note.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
