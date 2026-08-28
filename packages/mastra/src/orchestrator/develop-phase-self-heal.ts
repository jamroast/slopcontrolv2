import {
  buildDevelopPhaseChecksRevisionFeedback,
  developPhaseChecksSelfHealEligible,
  readPhaseDoc,
  readResearch,
  type FailureDiagnosis,
  validatePhaseDocForDev,
} from "@slopcontrol/artifacts";
import { syncPhaseArtifactsToWorktree } from "@slopcontrol/coding-tools";
import type { LlmRegistry } from "@slopcontrol/llm";
import type { Phase, Project, Run } from "@slopcontrol/types";

type SelfHealChecksResult = {
  ok: boolean;
  output: string;
  summary?: string;
};

export type DevelopPhaseChecksSelfHealResult =
  | { kind: "not_applicable" }
  | { kind: "revise_failed" }
  | { kind: "verify_passed"; phaseDoc: string; checks: SelfHealChecksResult }
  | { kind: "phase_revised"; phaseDoc: string; checks: SelfHealChecksResult };

export type DevelopPhaseChecksSelfHealDeps = {
  revisePhaseDoc: (input: {
    project: Project;
    phase: Phase;
    run: Run;
    feedback: string;
    research: string;
    intentBlock: string;
    designRoutingNote: string;
  }) => Promise<{ doc: string; harvested: boolean }>;
  runSuccessChecks: (
    project: Project,
    phaseDoc: string,
    cwd: string,
    opts: {
      mode: "full";
      phaseId: string;
      registry?: LlmRegistry;
    },
  ) => Promise<SelfHealChecksResult>;
};

export type DevelopPhaseChecksSelfHealInput = {
  project: Project;
  phase: Phase;
  run: Run;
  worktreePath: string;
  phaseDoc: string;
  diagnosis: FailureDiagnosis;
  intentBlock: string;
  designRoutingNote: string;
  attemptsUsed: number;
  failingStepName?: string;
  registry?: LlmRegistry;
  deps: DevelopPhaseChecksSelfHealDeps;
  log: (project: Project, run: Run, line: string) => void;
};

export async function attemptDevelopPhaseChecksSelfHeal(
  input: DevelopPhaseChecksSelfHealInput,
): Promise<DevelopPhaseChecksSelfHealResult> {
  const {
    project,
    phase,
    run,
    worktreePath,
    diagnosis,
    intentBlock,
    designRoutingNote,
    attemptsUsed,
    failingStepName,
    registry,
    deps,
    log,
  } = input;

  if (
    !developPhaseChecksSelfHealEligible(diagnosis, {
      failingStepName,
      attemptsUsed,
    })
  ) {
    return { kind: "not_applicable" };
  }

  const priorDoc = readPhaseDoc(project.rootPath, phase.id);
  const research = readResearch(project.rootPath, phase.id);
  const feedback = buildDevelopPhaseChecksRevisionFeedback(diagnosis);

  log(
    project,
    run,
    `--- Develop self-heal (faultLeg=phase-checks): revising PHASE.md via review agent ---`,
  );

  const revised = await deps.revisePhaseDoc({
    project,
    phase,
    run,
    feedback,
    research,
    intentBlock,
    designRoutingNote,
  });

  if (!revised.harvested || revised.doc.trim() === priorDoc.trim()) {
    log(
      project,
      run,
      revised.harvested
        ? "--- Develop self-heal: PHASE revision produced no diff ---"
        : "--- Develop self-heal: PHASE revision harvest failed ---",
    );
    return { kind: "revise_failed" };
  }

  const gate = validatePhaseDocForDev(revised.doc, {
    projectRoot: project.rootPath,
    phaseId: phase.id,
  });
  if (!gate.ok) {
    log(
      project,
      run,
      `--- Develop self-heal: revised PHASE failed validation — ${gate.issues.join("; ")} ---`,
    );
    return { kind: "revise_failed" };
  }

  syncPhaseArtifactsToWorktree({
    projectRoot: project.rootPath,
    worktreePath,
    phaseId: phase.id,
    preserveWorktreeEdits: false,
  });

  log(
    project,
    run,
    "--- Develop self-heal: re-running worktree verify after PHASE revision ---",
  );

  const checks = await deps.runSuccessChecks(
    project,
    revised.doc,
    worktreePath,
    {
      mode: "full",
      phaseId: phase.id,
      registry,
    },
  );

  if (checks.ok) {
    log(project, run, "--- Develop self-heal: verify passed after PHASE revision ---");
    return { kind: "verify_passed", phaseDoc: revised.doc, checks };
  }

  log(
    project,
    run,
    "--- Develop self-heal: verify still failing after PHASE revision — fall through to coding ---",
  );
  return { kind: "phase_revised", phaseDoc: revised.doc, checks };
}
