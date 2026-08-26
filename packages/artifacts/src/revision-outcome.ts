import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PersistedDiagnosis } from "./diagnosis.js";
import { docRevisionChanged } from "./verify-doc-revision.js";

function runDir(projectRoot: string, runId: string): string {
  return join(projectRoot, ".slopcontrol", "runs", runId);
}

export const RevisionTargetSchema = z.enum(["research", "phase", "both"]);
export type RevisionTarget = z.infer<typeof RevisionTargetSchema>;

export const RevisionArtifactOutcomeSchema = z.object({
  artifact: z.enum(["research", "phase"]),
  attempted: z.boolean(),
  harvested: z.boolean().optional(),
  changed: z.boolean().optional(),
  ok: z.boolean(),
  reason: z.string(),
  missing: z.array(z.string()).optional(),
});

export type RevisionArtifactOutcome = z.infer<
  typeof RevisionArtifactOutcomeSchema
>;

export const RevisionOutcomeSchema = z.object({
  targets: RevisionTargetSchema,
  ok: z.boolean(),
  updatedAt: z.string().datetime(),
  research: RevisionArtifactOutcomeSchema.optional(),
  phase: RevisionArtifactOutcomeSchema.optional(),
});

export type RevisionOutcome = z.infer<typeof RevisionOutcomeSchema>;

export function revisionOutcomePath(
  projectRoot: string,
  runId: string,
): string {
  return join(runDir(projectRoot, runId), "revision-outcome.json");
}

export function writeRevisionOutcome(
  projectRoot: string,
  runId: string,
  outcome: RevisionOutcome,
): RevisionOutcome {
  const parsed = RevisionOutcomeSchema.parse(outcome);
  const path = revisionOutcomePath(projectRoot, runId);
  mkdirSync(join(projectRoot, ".slopcontrol", "runs", runId), {
    recursive: true,
  });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  return parsed;
}

export function readRevisionOutcome(
  projectRoot: string,
  runId: string,
): RevisionOutcome | null {
  const path = revisionOutcomePath(projectRoot, runId);
  if (!existsSync(path)) return null;
  try {
    return RevisionOutcomeSchema.parse(
      JSON.parse(readFileSync(path, "utf-8")) as unknown,
    );
  } catch {
    return null;
  }
}

export function summarizeRevisionOutcome(outcome: RevisionOutcome): string {
  const parts = [`targets=${outcome.targets}`, `ok=${outcome.ok}`];
  for (const key of ["research", "phase"] as const) {
    const row = outcome[key];
    if (!row) continue;
    if (!row.attempted) {
      parts.push(`${key}=skipped`);
      continue;
    }
    parts.push(
      `${key}=${row.ok ? "ok" : "failed"}(${row.reason.replace(/\s+/g, " ").slice(0, 80)})`,
    );
  }
  return parts.join(" ");
}

/** Persisted when planning artifacts on disk fail validation after review revision. */
export function buildPlanningGateBlockedDiagnosis(opts: {
  issues: string[];
  phaseId: string;
  runId: string;
  restoredSnapshot?: boolean;
}): PersistedDiagnosis {
  const detail = opts.issues.join("; ").slice(0, 2_000);
  const fingerprint = createHash("sha256")
    .update(`planning-gate-blocked:${detail.slice(0, 400)}`)
    .digest("hex")
    .slice(0, 16);
  return {
    audience: "operator",
    operatorActions: [
      "Park submit_review(request_changes) — feedback is optional; SlopControl composes it from get_run.suggested_revision_feedback / phase_validation_issues.",
      "Do NOT call retry_draft at in_review.",
      "SlopControl will repair PHASE.md automatically on the next request_changes cycle when possible.",
    ],
    class: "process",
    confidence: "high",
    title: opts.restoredSnapshot
      ? "Review revision rolled back — PHASE.md restored to last on-disk snapshot"
      : "Review revision blocked — PHASE.md failed validation",
    rootCause: detail,
    evidence: detail.slice(0, 4_000),
    nextActions:
      "submit_review(request_changes) to retry revision; approve only after phase_validation_issues is empty.",
    fingerprint: `planning-gate-blocked-${fingerprint}`,
    codingAgentShouldFix: false,
    tags: ["planning", "planning-gate-blocked"],
    phaseId: opts.phaseId,
    runId: opts.runId,
    updatedAt: new Date().toISOString(),
  };
}

/** Persisted diagnosis when submit_review(request_changes) could not apply feedback. */
export function buildPlanningRevisionFailureDiagnosis(opts: {
  outcome: RevisionOutcome;
  feedback: string;
  phaseId: string;
  runId: string;
}): PersistedDiagnosis {
  const failed = [opts.outcome.research, opts.outcome.phase].filter(
    (row) => row?.attempted && !row.ok,
  );
  const first = failed[0];
  const kind =
    first?.harvested === false
      ? "revision-harvest-failed"
      : first?.missing?.length
        ? "revision-feedback-missing"
        : "revision-rejected";
  const detailParts = failed.map(
    (row) =>
      `${row!.artifact}: ${row!.reason}${row!.missing?.length ? ` — missing: ${row!.missing.join("; ")}` : ""}`,
  );
  const detail =
    detailParts.join("\n") ||
    summarizeRevisionOutcome(opts.outcome) ||
    opts.feedback.slice(0, 500);
  const fingerprint = createHash("sha256")
    .update(`review-revision:${kind}:${detail.slice(0, 400)}`)
    .digest("hex")
    .slice(0, 16);
  const operatorActions = [
    "Re-submit submit_review(request_changes) with explicit, bullet-point feedback for the failed artifact(s).",
    "Do NOT call retry_draft — in_review runs must use submit_review(request_changes) to revise PHASE.md/RESEARCH.md.",
    "Call get_run and inspect revision_outcome plus diagnosis — do not judge readiness from RESEARCH.md alone; read PHASE.md too.",
    failed.some((r) => r?.artifact === "research")
      ? "If research revision failed structurally at failed/interrupted stage, use rerun_research then retry_draft — not while in_review."
      : "Research revision succeeded — re-read RESEARCH.md and PHASE.md before approving.",
  ];
  return {
    audience: "operator",
    operatorActions,
    class: "process",
    confidence: "high",
    title: "Review revision did not fully apply operator feedback",
    rootCause: detail.slice(0, 2_000),
    evidence: [
      summarizeRevisionOutcome(opts.outcome),
      opts.feedback.trim().slice(0, 1_500),
    ]
      .filter(Boolean)
      .join("\n\n"),
    nextActions:
      "Fix the revision failure (see revision_outcome), then submit_review(request_changes) again or approve when both docs satisfy the feedback.",
    fingerprint: `planning-review-${kind}-${fingerprint}`,
    codingAgentShouldFix: false,
    tags: ["planning", "review-revision", kind],
    phaseId: opts.phaseId,
    runId: opts.runId,
    updatedAt: new Date().toISOString(),
  };
}

/** Persisted when submit_review(approve) is refused while still at in_review. */
export function buildReviewApprovalFailureDiagnosis(opts: {
  reason: string;
  phaseId: string;
  runId: string;
}): PersistedDiagnosis {
  const reason = opts.reason.trim().slice(0, 2_000);
  const fingerprint = createHash("sha256")
    .update(`review-approve-blocked:${reason.slice(0, 400)}`)
    .digest("hex")
    .slice(0, 16);
  return {
    audience: "operator",
    operatorActions: [
      "Park submit_review(request_changes) — feedback is optional; SlopControl composes it from get_run.suggested_revision_feedback / phase_validation_issues.",
      "Do NOT call retry_draft — that only works when stage is failed or interrupted, not in_review.",
      "After PHASE.md passes validation, submit_review(approve) or advance_run to start development.",
    ],
    class: "process",
    confidence: "high",
    title: "Review approval blocked — PHASE.md failed validation",
    rootCause: reason,
    evidence: reason.slice(0, 4_000),
    nextActions:
      "submit_review(request_changes) with fixes for the validation issues, then approve when clean.",
    fingerprint: `planning-review-approval-blocked-${fingerprint}`,
    codingAgentShouldFix: false,
    tags: ["planning", "review-approval-blocked"],
    phaseId: opts.phaseId,
    runId: opts.runId,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Compose submit_review(request_changes) feedback from live validation,
 * persisted diagnosis, revision outcome, and optional operator words.
 */
export function composeReviewRevisionFeedback(opts: {
  operatorHint?: string;
  diagnosis?: PersistedDiagnosis | null;
  revisionOutcome?: RevisionOutcome | null;
  phaseValidationIssues?: string[];
  maxChars?: number;
}): string {
  const maxChars = opts.maxChars ?? 8_000;
  const hint = opts.operatorHint?.trim() ?? "";
  const parts: string[] = [];

  if (hint) {
    parts.push(`Operator request: ${hint}`);
  }

  const issues = (opts.phaseValidationIssues ?? []).filter(Boolean);
  if (issues.length > 0) {
    parts.push(
      "Fix PHASE.md so it passes development validation (Automated Checks must be finite and structurally valid):\n" +
        issues.map((i) => `- ${i}`).join("\n"),
    );
  }

  const d = opts.diagnosis;
  if (d?.tags?.includes("review-approval-blocked")) {
    parts.push(`Approval was refused:\n${d.rootCause}`);
  } else if (d?.tags?.includes("review-revision")) {
    parts.push(
      `Prior review revision did not fully apply (${d.title}):\n${d.rootCause}`,
    );
    if (d.evidence?.trim() && d.evidence !== d.rootCause) {
      parts.push(d.evidence.trim().slice(0, 2_000));
    }
  } else if (d?.rootCause?.trim()) {
    parts.push(`${d.title}:\n${d.rootCause}`);
  }

  const ro = opts.revisionOutcome;
  if (ro && !ro.ok) {
    parts.push(`Revision outcome: ${summarizeRevisionOutcome(ro)}`);
    if (ro.phase?.attempted && !ro.phase.ok) {
      parts.push(`PHASE revision: ${ro.phase.reason}`);
    }
    if (ro.research?.attempted && !ro.research.ok) {
      parts.push(`RESEARCH revision: ${ro.research.reason}`);
    }
  }

  if (parts.length === 0) {
    return hint;
  }

  parts.push(
    "Revise the minimum sections needed (usually ## Automated Checks in PHASE.md). Do not rerun research unless RESEARCH.md is wrong.",
  );

  return parts.join("\n\n").slice(0, maxChars);
}

export function buildRevisionArtifactOutcome(opts: {
  artifact: "research" | "phase";
  attempted: boolean;
  before?: string;
  after?: string;
  harvested?: boolean;
  verdict?: { ok: boolean; changed: boolean; reason: string; missing: string[] };
  skipReason?: string;
  failReason?: string;
}): RevisionArtifactOutcome {
  if (!opts.attempted) {
    return {
      artifact: opts.artifact,
      attempted: false,
      ok: true,
      reason: opts.skipReason ?? "not targeted",
    };
  }
  if (opts.harvested === false) {
    return {
      artifact: opts.artifact,
      attempted: true,
      harvested: false,
      ok: false,
      reason: opts.failReason ?? "harvest failed",
    };
  }
  const changed =
    opts.verdict?.changed ??
    (opts.before !== undefined && opts.after !== undefined
      ? docRevisionChanged(opts.before, opts.after)
      : undefined);
  if (opts.verdict) {
    return {
      artifact: opts.artifact,
      attempted: true,
      harvested: true,
      changed,
      ok: opts.verdict.ok,
      reason: opts.verdict.reason,
      missing: opts.verdict.missing.length ? opts.verdict.missing : undefined,
    };
  }
  return {
    artifact: opts.artifact,
    attempted: true,
    harvested: true,
    changed,
    ok: true,
    reason: "applied",
  };
}
