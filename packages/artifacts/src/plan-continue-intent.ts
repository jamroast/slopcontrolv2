/**
 * Structured intent for plan-loop continues.
 */

import { z } from "zod";

export const PlanContinueIntentScopeSchema = z.enum([
  "sections",
  "expand_scope",
  "narrow_scope",
  "full_revise",
  "clarify_only",
]);
export type PlanContinueIntentScope = z.infer<
  typeof PlanContinueIntentScopeSchema
>;

export const PlanContinueIntentSchema = z.object({
  scope: PlanContinueIntentScopeSchema,
  /** PLAN.md section titles to revise (e.g. "Approach", "Likely areas"). */
  sections: z.array(z.string()).default([]),
  /** Optional focus/preserve patch for conceptual scope. */
  focus: z.string().optional(),
  preserve: z.array(z.string()).optional(),
  /** True when the revision needs a repo investigation pass first. */
  needsInvestigation: z.boolean().default(false),
  notes: z.string().default(""),
});
export type PlanContinueIntent = z.infer<typeof PlanContinueIntentSchema>;

export const PLAN_CONTINUE_INTENT_DEFAULT: PlanContinueIntent = {
  scope: "sections",
  sections: [],
  needsInvestigation: false,
  notes: "",
};

/**
 * Neutral intent used when the continue classifier is unavailable —
 * clarify_only preserves PLAN.md so the operator steers the next turn
 * (never guess an expensive investigate/regenerate on classifier failure).
 */
export const PLAN_CONTINUE_INTENT_FALLBACK: PlanContinueIntent = {
  scope: "clarify_only",
  sections: [],
  needsInvestigation: false,
  notes: "classifier unavailable — operator steering required",
};

/**
 * Schema-only coherence after LLM (or fallback) classification.
 * Does not re-read operator text — no regex overrides on success path.
 */
export function normalizePlanContinueIntentStructured(
  intent: PlanContinueIntent,
): PlanContinueIntent {
  let scope = intent.scope;
  let focus = intent.focus;
  if (scope === "expand_scope" || scope === "full_revise") {
    if (
      focus &&
      /^(management|workflows?|projects?|only|just)$/i.test(focus)
    ) {
      focus = undefined;
    }
  }

  let sections = intent.sections;
  if (
    (scope === "expand_scope" || scope === "full_revise") &&
    sections.length < 3
  ) {
    sections = [
      "Goal",
      "In scope",
      "Out of scope",
      "Approach",
      "Likely areas",
      "Success criteria",
      "Risks & open questions",
      "Handoff notes",
    ];
  }

  const preserve =
    scope === "narrow_scope"
      ? intent.preserve?.length
        ? intent.preserve
        : ["unrelated modules"]
      : scope === "expand_scope" || scope === "full_revise"
        ? undefined
        : intent.preserve;

  return PlanContinueIntentSchema.parse({
    ...intent,
    scope,
    sections,
    focus,
    preserve,
  });
}

/**
 * @deprecated Prefer normalizePlanContinueIntentStructured. Text arg ignored.
 */
export function normalizePlanContinueIntent(
  intent: PlanContinueIntent,
  _text?: string,
): PlanContinueIntent {
  return normalizePlanContinueIntentStructured(intent);
}

export function formatPlanContinueIntentPromptBlock(
  intent: PlanContinueIntent,
): string {
  const lines = [`PLAN CONTINUE INTENT: ${intent.scope}`];
  if (intent.scope === "full_revise") {
    lines.push(
      "- Full revise allowed; emit ALL required PLAN.md H2 sections (stubs OK).",
    );
    lines.push(
      "- Prior acceptance locks are REOPENED for this turn — Goal/In scope MAY change.",
    );
  } else if (intent.scope === "expand_scope") {
    lines.push(
      "- Expand the plan: update Goal/In scope/Approach as needed; emit ALL required H2 sections.",
    );
    lines.push(
      "- Prior acceptance locks are REOPENED for this turn — do not preserve the old Goal solely because it was ticked.",
    );
  } else if (intent.scope === "clarify_only") {
    lines.push(
      "- Clarify in NOTES; prefer preserving PLAN.md unless a factual correction is needed.",
    );
  } else {
    lines.push(
      "- Revise surgically; preserve Goal/Out of scope unless those sections are targeted.",
    );
  }
  if (intent.sections.length) {
    lines.push(`- Change sections: ${intent.sections.join(", ")}.`);
  }
  if (intent.focus) {
    lines.push(`- Focus patch: ${intent.focus}`);
  }
  if (intent.preserve?.length) {
    lines.push(`- Preserve: ${intent.preserve.join(", ")}`);
  }
  if (intent.notes.trim()) {
    lines.push(`- Summary: ${intent.notes.trim().slice(0, 300)}`);
  }
  return lines.join("\n");
}
