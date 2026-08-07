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
  notes: z.string().default(""),
});
export type PlanContinueIntent = z.infer<typeof PlanContinueIntentSchema>;

export const PLAN_CONTINUE_INTENT_DEFAULT: PlanContinueIntent = {
  scope: "sections",
  sections: [],
  notes: "",
};

/** True when operator clearly wants to grow / extend the plan. */
export function textSignalsPlanExpand(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(expand|also\s+include|widen|broader|extend(\s+the)?\s+plan|broaden(\s+the)?\s+plan)\b/i.test(
      t,
    ) ||
    /\badd\b.{0,40}\bin\s*scope\b/i.test(t) ||
    /\bfirst\s+component\b/i.test(t) ||
    /\bnew\s+(component|capability|feature|system)\b/i.test(t) ||
    /\bpresent(\s+me)?(\s+with)?\s+a\s+plan\b/i.test(t) ||
    /\bresearch\s+this,?\s+and\s+present\b/i.test(t) ||
    /\bplease\s+research\b.{0,80}\bplan\b/i.test(t)
  );
}

export function textSignalsPlanFullRevise(text: string): boolean {
  return /\b(redesign|rewrite|start\s+over|from\s+scratch|full\s+revise)\b/i.test(
    text ?? "",
  );
}

/**
 * Narrow cues — ignore "not only …" and do not treat bare "management" as focus.
 */
export function textSignalsPlanNarrow(text: string): boolean {
  const t = (text ?? "").replace(/\bnot\s+only\b/gi, " ");
  return (
    /\b(narrow|shrink)\b/i.test(t) ||
    /\b(?:focus\s+on|only|just)\b.{0,40}\b(this|that|the)\b/i.test(t) ||
    (/\b(?:only|just)\b.{0,30}\b([a-z0-9._/-]{3,40})\b/i.test(t) &&
      !textSignalsPlanExpand(text) &&
      !textSignalsPlanFullRevise(text))
  );
}

export function fallbackPlanContinueIntentFromText(
  text: string,
): PlanContinueIntent {
  const t = text ?? "";
  const sections: string[] = [];
  const sectionHints: Array<{ title: string; re: RegExp }> = [
    { title: "Goal", re: /\bgoal\b/i },
    { title: "Constraints", re: /\bconstraints?\b/i },
    { title: "In scope", re: /\bin\s*scope\b/i },
    { title: "Out of scope", re: /\bout\s*of\s*scope\b/i },
    { title: "Approach", re: /\bapproach\b|\bsteps?\b/i },
    { title: "Likely areas", re: /\blikely\s*areas?\b|\bfiles?\b|\bmodules?\b/i },
    { title: "Success criteria", re: /\bsuccess\b|\bdone\s*when\b|\bacceptance\b/i },
    {
      title: "Risks & open questions",
      re: /\brisks?\b|\bopen\s*questions?\b|\buncertaint/i,
    },
    { title: "Handoff notes", re: /\bhandoff\b/i },
  ];
  for (const h of sectionHints) {
    if (h.re.test(t)) sections.push(h.title);
  }

  const wantsFull = textSignalsPlanFullRevise(t);
  const expand = textSignalsPlanExpand(t);
  const narrow = textSignalsPlanNarrow(t) && !wantsFull && !expand;
  const clarify =
    /\b(what|why|how|explain|clarify|\?)\b/i.test(t) &&
    !/\b(update|change|add|remove|revise|rewrite|extend|present|research)\b/i.test(
      t,
    ) &&
    sections.length === 0 &&
    !expand &&
    !wantsFull;

  let scope: PlanContinueIntentScope = "sections";
  if (wantsFull) scope = "full_revise";
  else if (expand) scope = "expand_scope";
  else if (clarify) scope = "clarify_only";
  else if (narrow) scope = "narrow_scope";

  let focus: string | undefined;
  if (narrow || scope === "narrow_scope") {
    const cleaned = t.replace(/\bnot\s+only\b/gi, " ");
    const focusMatch = cleaned.match(
      /\b(?:focus\s+on)\b.{0,30}\b([a-z0-9._/-]{3,40})\b/i,
    );
    if (focusMatch?.[1]) focus = focusMatch[1].toLowerCase();
  }

  const preserve: string[] = [];
  if (scope === "narrow_scope") {
    preserve.push("unrelated modules");
  }

  const expandSections =
    scope === "expand_scope" || scope === "full_revise"
      ? [
          "Goal",
          "In scope",
          "Out of scope",
          "Approach",
          "Likely areas",
          "Success criteria",
          "Risks & open questions",
          "Handoff notes",
        ]
      : [];

  return PlanContinueIntentSchema.parse({
    scope,
    sections: [...new Set([...sections, ...expandSections])],
    focus,
    preserve: preserve.length ? preserve : undefined,
    notes: "",
  });
}

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
