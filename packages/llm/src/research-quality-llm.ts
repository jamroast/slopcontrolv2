import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import {
  chatJson,
  CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
  CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
} from "./json-chat.js";

/**
 * General RESEARCH.md quality judge — runs after the research agent for every
 * phase (not only engagement/interaction contracts).
 */

export const ResearchQualityVerdictSchema = z.object({
  /** true = RESEARCH.md is adequate to draft PHASE.md from. */
  ok: z.boolean(),
  /** Specific gaps (empty when ok). */
  gaps: z.array(z.string()),
  /** Concrete lines/sections to add (parallel to gaps). */
  suggestedFixes: z.array(z.string()),
});

export type ResearchQualityVerdict = z.infer<typeof ResearchQualityVerdictSchema>;

export const RESEARCH_QUALITY_SYSTEM_PROMPT = `You are SlopControl's RESEARCH.md quality judge. You decide whether a research document is complete enough to draft an execution-ready PHASE.md. Respond with ONLY a single JSON object.

Schema:
- ok: boolean — true when research is adequate to draft from.
- gaps: array of strings — what's missing (empty when ok).
- suggestedFixes: array of strings — concrete additions parallel to gaps.

Judge against the Change Intent + phase description. Check ALL of:
1. Problem summary with verified repo findings (file:line or concrete paths where possible).
2. Scope coverage — every success criterion / affected area from the intent is researched, not hand-waved.
3. uiMount honour — when uiMount is page/composer/bubble/modal, research names the concrete mount/route/surface (not abstract "add sign-in flow").
4. Proposed implementation — specific files to touch, build order, risks.
5. Proposed Automated Checks — at least structural/grep/build checks research recommends for PHASE (finite; no long-lived dev servers; no duplicate infra bring-up — verify starts test-services, so checks must not re-up Postgres/Redis/etc. with docker compose).
6. Open risks / verification gaps — hypotheses stated as hypotheses, not "already works" without evidence.

Verdict rules:
- ok=true only when a phase planner could write PHASE.md Scope/File Changes/Success Criteria/Automated Checks/Blueprint Deltas from this research alone.
- When in doubt, prefer ok=false (fail closed).
- Do NOT require Playwright/fill-submit proofs in research unless Change Intent includes an interaction contract with submit form.`;

export interface JudgeResearchQualityOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  intentBlock: string;
  phaseDescription: string;
  researchExcerpt: string;
  timeoutMs?: number;
}

const EXCERPT_TAIL_CHARS = 16_000;

function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

export function parseResearchQualityVerdictPayload(
  parsed: unknown,
): ResearchQualityVerdict {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const gaps = Array.isArray(asObj.gaps)
    ? asObj.gaps.filter((g): g is string => typeof g === "string" && g.trim() !== "")
    : [];
  const suggestedFixes = Array.isArray(asObj.suggestedFixes)
    ? asObj.suggestedFixes.filter(
        (s): s is string => typeof s === "string" && s.trim() !== "",
      )
    : [];
  const okIsBool = typeof asObj.ok === "boolean";
  const ok = okIsBool ? asObj.ok : false;
  return ResearchQualityVerdictSchema.parse({
    ok,
    gaps:
      gaps.length > 0
        ? gaps
        : okIsBool
          ? []
          : ["Research quality could not be verified (unreadable judge verdict)"],
    suggestedFixes,
  });
}

export async function judgeResearchQualityViaLlm(
  opts: JudgeResearchQualityOptions,
): Promise<ResearchQualityVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
    maxTokens: CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
    system: RESEARCH_QUALITY_SYSTEM_PROMPT,
    user: [
      "Change Intent (authoritative):",
      opts.intentBlock,
      "",
      "Phase description:",
      clip(opts.phaseDescription ?? "", 4_000),
      "",
      "RESEARCH.md excerpt:",
      clip(opts.researchExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parseResearchQualityVerdictPayload(parsed);
}
