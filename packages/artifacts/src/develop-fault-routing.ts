/**
 * Develop-loop fault routing: map verify diagnoses to the leg that should fix them.
 * Mirrors planning `faultLeg` — phase harness fixes go to revisePhaseDoc, not coding.
 */

export type DevelopFaultLeg = "none" | "phase-checks" | "product" | "infra";

/** Max orchestrator-owned PHASE.md revisions per develop run (harness self-heal). */
export const MAX_DEVELOP_PHASE_CHECKS_SELF_HEAL = 2;

const PHASE_CHECKS_TAGS = new Set([
  "automated-checks",
  "duplicate-infra",
  "container-conflict",
  "check-timeout",
  "long-lived",
  "host-utility",
  "macos-portability",
]);

export type DevelopFaultDiagnosis = {
  class: string;
  audience: string;
  title: string;
  rootCause: string;
  nextActions: string;
  tags?: string[];
  codingAgentShouldFix: boolean;
  harnessRecoverable?: boolean;
};

/** True when the failure is a broken PHASE.md Automated Check / harness script. */
export function isPhaseChecksProcessFault(d: DevelopFaultDiagnosis): boolean {
  const hay = [d.title, d.rootCause, d.nextActions].join("\n");
  if (
    /api-routing|Stream started hang|api-routing-complete-gate|model-resolver|chat route|OLLAMA_BASE_URL routing/i.test(
      hay,
    )
  ) {
    return false;
  }
  if (d.tags?.some((t) => PHASE_CHECKS_TAGS.has(t))) return true;
  return /PHASE\.md|Automated Check|CHECK_TIMEOUT|host utility|duplicate infra|docker compose up|trap.*docker compose down|Broken Automated Check/i.test(
    hay,
  );
}

export function developFaultLegFromDiagnosis(
  d: DevelopFaultDiagnosis,
  opts?: { failingStepName?: string },
): DevelopFaultLeg {
  if (opts?.failingStepName === "phase-doc-validation") return "phase-checks";

  if (
    d.class === "infra" ||
    (d.audience === "operator" && d.codingAgentShouldFix === false)
  ) {
    return "infra";
  }

  if (d.class === "process" && isPhaseChecksProcessFault(d)) {
    return "phase-checks";
  }

  if (d.class === "product" || d.codingAgentShouldFix) {
    return "product";
  }

  return "none";
}

/** Feedback brief for reviewAgent when develop self-heal revises PHASE.md. */
export function buildDevelopPhaseChecksRevisionFeedback(
  d: DevelopFaultDiagnosis,
): string {
  const lines = [
    "Develop verify failed on a **process / Automated Checks harness** issue — fix PHASE.md only unless Scope truly must change.",
    "",
    `Diagnosis: ${d.title}`,
    "",
    "### Root cause",
    d.rootCause.trim() || "(see diagnosis evidence)",
    "",
    "### Required Automated Checks changes",
  ];
  if (d.nextActions?.trim()) {
    lines.push(d.nextActions.trim());
  } else {
    lines.push(
      "- Remove duplicate infra bring-up (`docker compose up`, `trap 'docker compose down' EXIT`) — SlopControl test-services already starts Postgres/Redis/etc.",
      "- Use finite asserts: migrate/seed/targeted `npx vitest run <file>`, grep, or build/typecheck.",
      "- Do not start long-lived dev servers or background `&` + `wait` patterns.",
    );
  }
  lines.push(
    "",
    "Preserve ## Scope, ## File Changes, and ## Success Criteria unless the diagnosis explicitly requires otherwise.",
    "Do not weaken product proof — fix the check script, not the success criteria.",
  );
  return lines.join("\n");
}

export function developPhaseChecksSelfHealEligible(
  d: DevelopFaultDiagnosis,
  opts?: { failingStepName?: string; attemptsUsed?: number },
): boolean {
  if ((opts?.attemptsUsed ?? 0) >= MAX_DEVELOP_PHASE_CHECKS_SELF_HEAL) {
    return false;
  }
  return developFaultLegFromDiagnosis(d, opts) === "phase-checks";
}
