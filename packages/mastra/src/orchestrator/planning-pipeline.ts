/**
 * Planning pipeline self-heal: fault routing and judge retry helpers.
 */

export type PlanningFaultLeg = "none" | "research" | "draft" | "both";

/** Max outer self-heal rounds (research → draft → intent gate). */
export const MAX_PLANNING_SELF_HEAL_ROUNDS = 3;

/** Max retries per leg when that leg's quality judge rejects. */
export const MAX_PLANNING_LEG_RETRIES = 2;

/** Max JSON judge retries on infra/parse failure before fail-closed. */
export const MAX_PLANNING_JUDGE_RETRIES = 3;

const INFRA_ISSUE_RE =
  /could not be verified|unreadable judge|LLM judge failed|judge failed/i;

export function isPlanningJudgeInfraIssue(issue: string): boolean {
  return INFRA_ISSUE_RE.test(issue);
}

export function mergeFaultLegs(
  ...legs: Array<PlanningFaultLeg | undefined>
): PlanningFaultLeg {
  const set = new Set(legs.filter(Boolean));
  if (set.has("both") || (set.has("research") && set.has("draft"))) {
    return "both";
  }
  if (set.has("research")) return "research";
  if (set.has("draft")) return "draft";
  return "none";
}

export function formatJudgeFeedbackBlock(opts: {
  title: string;
  gaps: string[];
  suggestedFixes?: string[];
}): string {
  if (opts.gaps.length === 0) return "";
  const fixes =
    opts.suggestedFixes && opts.suggestedFixes.length > 0
      ? opts.suggestedFixes.map((s, i) => `- ${s}`).join("\n")
      : "";
  return `${opts.title}:
${opts.gaps.map((g) => `- ${g}`).join("\n")}${fixes ? `\nSuggested fixes:\n${fixes}` : ""}`;
}

export function researchQualityRetryPrompt(opts: {
  intentBlock: string;
  description: string;
  researchPath: string;
  researchDate: string;
  judgeFeedback: string;
}): string {
  return `Your previous RESEARCH.md failed the quality judge.
${opts.judgeFeedback}

Rewrite the FULL RESEARCH.md. Rules:
- Use Date: ${opts.researchDate} near the top.
- Include verified file paths, proposed Automated Checks for PHASE, risks, and concrete uiMount decisions.
- write_file path: ${opts.researchPath}
- Also return the same markdown starting with #.
- End with RESEARCH_COMPLETE.

${opts.intentBlock}

Change request:
${opts.description}`;
}

export function phaseQualityRetryPrompt(opts: {
  canonicalPath: string;
  intentBlock: string;
  description: string;
  research: string;
  judgeFeedback: string;
}): string {
  return `Your previous PHASE.md failed the quality judge.
${opts.judgeFeedback}

Rewrite the FULL PHASE.md starting with # Title — output ONLY the markdown document.
If you use write_file, path must be exactly: ${opts.canonicalPath}
Required sections: ## Scope, ## File Changes, ## Success Criteria, ## Automated Checks (bash fence), ## Blueprint Deltas.
Base Scope/File Changes ONLY on the RESEARCH below.
${opts.intentBlock}
End with PHASE_COMPLETE.

Description:
${opts.description}

Research:
${opts.research}`;
}

/** Run a planning JSON judge with infra/parse retries (does not burn leg-repair passes). */
export async function callPlanningJudgeWithInfraRetry<T>(
  call: () => Promise<T>,
  extractGaps: (result: T) => string[],
  maxRetries: number = MAX_PLANNING_JUDGE_RETRIES,
): Promise<{ result: T; judgeInfraFailed: boolean }> {
  let last: T | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      last = await call();
      const gaps = extractGaps(last);
      const infra = gaps.some(isPlanningJudgeInfraIssue);
      if (!infra) return { result: last, judgeInfraFailed: false };
      if (attempt < maxRetries - 1) continue;
      return { result: last, judgeInfraFailed: true };
    } catch {
      if (attempt < maxRetries - 1) continue;
      if (last) return { result: last, judgeInfraFailed: true };
      throw new Error("Planning judge failed with no verdict");
    }
  }
  throw new Error("Planning judge retry loop exhausted");
}

export function faultLegFromPhaseQualityVerdict(opts: {
  ok: boolean;
  researchFaults: string[];
  draftFaults: string[];
}): PlanningFaultLeg {
  if (opts.ok) return "none";
  const hasResearch = opts.researchFaults.length > 0;
  const hasDraft =
    opts.draftFaults.length > 0 || (!hasResearch && !opts.ok);
  return mergeFaultLegs(
    hasResearch ? "research" : "none",
    hasDraft ? "draft" : "none",
  );
}

/** Whether the planning self-heal loop should re-run research/draft legs. */
export function shouldContinuePlanningSelfHeal(opts: {
  stage: string;
  faultLeg: PlanningFaultLeg;
  judgeInfraFailed?: boolean;
  round: number;
  maxRounds: number;
}): boolean {
  return (
    opts.stage === "failed" &&
    !opts.judgeInfraFailed &&
    opts.faultLeg !== "none" &&
    opts.round < opts.maxRounds - 1
  );
}
