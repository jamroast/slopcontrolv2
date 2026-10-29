/**
 * Run payload builders for the dashboard/MCP run endpoints.
 *
 * `buildRunPayload` has two modes:
 * - detail (default) — the full payload for GET /runs/:id: full RESEARCH.md,
 *   PHASE.md, the 500-line log tail, and the in_review validation/feedback
 *   compositions.
 * - list (`includeHeavy: false`) — the slim payload for the LIST endpoints.
 *   It skips every heavy per-run read (log tails, RESEARCH/PHASE docs,
 *   phase validation) and omits those keys. With hundreds of runs and
 *   multi-MB logs the full payload turned a listing into a >17MB,
 *   multi-second response — and the MCP list_runs tool dumped that whole
 *   blob into the LLM context.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  composeReviewRevisionFeedback,
  diagnosisForRunStage,
  handoffSummary,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  readLatestHandoffForPhase,
  readPhaseDoc,
  readResearch,
  readResearchConclusionForPhase,
  readRevisionOutcome,
  readRunHandoff,
  readVerifyStepsReport,
  validatePhaseDocForDev,
} from "@slopcontrol/artifacts";
import {
  formatDurationMs,
  unmetPhaseDependencies,
  type Run,
} from "@slopcontrol/types";
import type { SlopStore } from "./store.js";

export type RunPayloadStore = Pick<
  SlopStore,
  "getProject" | "getPhase" | "listPhases"
>;

export type RunPayloadDeps = {
  store: RunPayloadStore;
  activeRuns: ReadonlySet<string>;
};

function readTailLines(filePath: string, maxLines: number): string {
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return "";
    const CHUNK = 8192;
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = stat.size;
      let lines: string[] = [];
      let leftover = "";

      while (pos > 0 && lines.length < maxLines) {
        const readSize = Math.min(CHUNK, pos);
        pos -= readSize;
        readSync(fd, buf, 0, readSize, pos);
        const chunk = buf.toString("utf-8", 0, readSize) + leftover;
        const parts = chunk.split("\n");
        leftover = parts.shift() ?? "";
        lines = [...parts, ...lines];
      }
      if (leftover && lines.length < maxLines) {
        lines = [leftover, ...lines];
      }
      // Return only the last maxLines
      return lines.slice(-maxLines).join("\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function safeReadResearch(
  projectRoot: string,
  phaseId: string,
): string {
  try {
    return readResearch(projectRoot, phaseId);
  } catch {
    return "";
  }
}

export function buildRunPayload(
  deps: RunPayloadDeps,
  run: Run,
  opts?: { includeHeavy?: boolean },
) {
  const { store, activeRuns } = deps;
  const includeHeavy = opts?.includeHeavy !== false;
  const project = store.getProject(run.projectId);
  const phase = store.getPhase(run.phaseId);
  if (!project) return null;

  // Tombstone row: merged into an archive run — no fs reads, cheap listing.
  if (run.archived && run.archivedInto) {
    return {
      id: run.id,
      archived: true,
      archived_into: run.archivedInto,
      project_id: run.projectId,
      phase_id: run.phaseId,
      stage: run.stage,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      researchRunning: false,
      devRunning: false,
    };
  }

  // Synthetic archive run: surface the compaction manifest.
  let archiveManifest: unknown = null;
  if (run.archived && run.mergedRunIds) {
    const archiveRoot = join(project.rootPath, ".slopcontrol", "archive");
    try {
      for (const dir of readdirSync(archiveRoot)) {
        if (!dir.startsWith("runs-compact-")) continue;
        const manifestPath = join(archiveRoot, dir, "ARCHIVE.json");
        if (!existsSync(manifestPath)) continue;
        const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          archiveRunId?: string;
        };
        if (parsed.archiveRunId === run.id) {
          archiveManifest = parsed;
          break;
        }
      }
    } catch {
      /* archive dir missing or unreadable — payload still works */
    }
  }

  // Cheap per-run reads (small JSON files) — kept in both modes.
  const diagnosisRaw =
    readDiagnosis(project.rootPath, run.id) ??
    (phase ? readLatestDiagnosisForPhase(project.rootPath, phase.id) : null);
  const diagnosis = diagnosisForRunStage(diagnosisRaw, run.stage);
  const handoff =
    readRunHandoff(project.rootPath, run.id) ??
    (phase ? readLatestHandoffForPhase(project.rootPath, phase.id) : null);
  const verifySteps = readVerifyStepsReport(project.rootPath, run.id);
  const revisionOutcome = readRevisionOutcome(project.rootPath, run.id);

  // Heavy per-run reads — detail view only. Skipped for list endpoints.
  let devOutput = "";
  let phaseDoc = "";
  let researchOutput = "";
  let researchConclusion = "";
  let phaseValidation: ReturnType<typeof validatePhaseDocForDev> | null = null;
  let suggestedRevisionFeedback: string | null = null;
  if (includeHeavy) {
    const logPath = join(
      project.rootPath,
      ".slopcontrol",
      "runs",
      run.id,
      "log.txt",
    );
    if (existsSync(logPath)) {
      devOutput = readTailLines(logPath, 500);
    }
    if (phase) {
      phaseDoc = readPhaseDoc(project.rootPath, phase.id);
      researchOutput = safeReadResearch(project.rootPath, phase.id);
    }
    researchConclusion =
      phase && (run.stage === "in_review" || run.stage === "accepted")
        ? readResearchConclusionForPhase(project.rootPath, phase.id)
        : "";
    phaseValidation =
      phase && phaseDoc && run.stage === "in_review"
        ? validatePhaseDocForDev(phaseDoc, {
            projectRoot: project.rootPath,
            phaseId: phase.id,
          })
        : null;
    suggestedRevisionFeedback =
      run.stage === "in_review"
        ? composeReviewRevisionFeedback({
            diagnosis,
            revisionOutcome,
            phaseValidationIssues: phaseValidation?.issues,
          })
        : null;
  }

  return {
    id: run.id,
    idea: run.archiveTitle ?? phase?.description ?? "",
    project_dir: project.rootPath,
    stage: run.stage,
    archived: run.archived === true ? true : undefined,
    merged_run_ids: run.mergedRunIds,
    archive: archiveManifest,
    phase_id: phase?.id ?? null,
    phase_depends_on: phase?.dependsOn ?? [],
    phase_deps_unmet: phase
      ? unmetPhaseDependencies(phase, store.listPhases(run.projectId))
      : [],
    project_id: run.projectId,
    iteration_count: run.iterationCount,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt ?? null,
    finished_at: run.finishedAt ?? null,
    total_duration_ms: run.totalDurationMs ?? null,
    total_duration: formatDurationMs(run.totalDurationMs),
    stage_timings: (run.stageTimings ?? []).map((t) => ({
      stage: t.stage,
      started_at: t.startedAt,
      ended_at: t.endedAt ?? null,
      duration_ms: t.durationMs ?? null,
      duration: formatDurationMs(t.durationMs),
    })),
    researchRunning: activeRuns.has(run.id),
    devRunning: activeRuns.has(run.id),
    diagnosis,
    failure_summary: diagnosis
      ? `${diagnosis.title}${diagnosis.rootCause ? `: ${diagnosis.rootCause.slice(0, 240)}` : ""}`
      : null,
    handoff: handoffSummary(handoff),
    operator_suggestions: diagnosis
      ? {
          audience: diagnosis.audience,
          actions: diagnosis.operatorActions,
          class: diagnosis.class,
          title: diagnosis.title,
          codingAgentShouldFix: diagnosis.codingAgentShouldFix,
        }
      : null,
    verify_first_failure: verifySteps?.firstFailure
      ? {
          id: verifySteps.firstFailure.id,
          name: verifySteps.firstFailure.name,
          exitCode: verifySteps.firstFailure.exitCode,
          command: verifySteps.firstFailure.command,
        }
      : null,
    verify_ok: verifySteps ? verifySteps.ok : null,
    revision_outcome: revisionOutcome,
    ...(includeHeavy
      ? {
          research_output: researchOutput,
          research_conclusion: researchConclusion || null,
          dev_output: devOutput,
          phase_doc: phaseDoc,
          verify_steps: verifySteps?.steps ?? null,
          phase_validation_issues: phaseValidation?.issues?.length
            ? phaseValidation.issues
            : null,
          suggested_revision_feedback: suggestedRevisionFeedback || null,
        }
      : {}),
  };
}
