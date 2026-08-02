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

  const wantsFull =
    /\b(redesign|rewrite|start\s+over|from\s+scratch|full\s+revise)\b/i.test(t);
  const clarify =
    /\b(what|why|how|explain|clarify|\?)\b/i.test(t) &&
    !/\b(update|change|add|remove|revise|rewrite)\b/i.test(t) &&
    sections.length === 0;
  const expand =
    /\b(expand|also\s+include|widen|broader)\b/i.test(t) ||
    /\badd\b.{0,40}\bin\s*scope\b/i.test(t);
  const narrow =
    /\b(narrow|only|just|shrink|out\s*of\s*scope)\b/i.test(t) &&
    !wantsFull;

  let scope: PlanContinueIntentScope = "sections";
  if (wantsFull) scope = "full_revise";
  else if (clarify) scope = "clarify_only";
  else if (expand) scope = "expand_scope";
  else if (narrow) scope = "narrow_scope";

  let focus: string | undefined;
  const focusMatch = t.match(
    /\b(?:focus\s+on|only|just)\b.{0,30}\b([a-z0-9._/-]{3,40})/i,
  );
  if (focusMatch?.[1]) focus = focusMatch[1].toLowerCase();

  const preserve: string[] = [];
  if (narrow) {
    preserve.push("unrelated modules");
  }

  return PlanContinueIntentSchema.parse({
    scope,
    sections: [...new Set(sections)],
    focus,
    preserve: preserve.length ? preserve : undefined,
    notes: "",
  });
}

export function formatPlanContinueIntentPromptBlock(
  intent: PlanContinueIntent,
): string {
  const lines = [`PLAN CONTINUE INTENT: ${intent.scope}`];
  if (intent.scope === "full_revise") {
    lines.push("- Full revise allowed; keep required PLAN.md sections.");
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
