import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import {
  chatJson,
  CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
  CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
} from "./json-chat.js";

/**
 * PHASE.md quality judge — validates the draft execution contract before
 * intent-alignment gates run.
 */

export const PhaseDocQualityVerdictSchema = z.object({
  /** true = PHASE.md is substantive and implements RESEARCH (not scaffold). */
  ok: z.boolean(),
  gaps: z.array(z.string()),
  suggestedFixes: z.array(z.string()),
  /**
   * Gaps attributable to thin/missing RESEARCH (research leg should re-run).
   * Subset of gaps — may be empty even when ok=false.
   */
  researchFaults: z.array(z.string()),
  /**
   * Gaps where RESEARCH was adequate but PHASE failed to translate it.
   */
  draftFaults: z.array(z.string()),
});

export type PhaseDocQualityVerdict = z.infer<typeof PhaseDocQualityVerdictSchema>;

export const PHASE_DOC_QUALITY_SYSTEM_PROMPT = `You are SlopControl's PHASE.md quality judge. You decide whether a PHASE.md draft is execution-ready and faithfully implements RESEARCH.md + Change Intent. Respond with ONLY a single JSON object.

Schema:
- ok: boolean
- gaps: string[] — all issues (empty when ok)
- suggestedFixes: string[] — concrete fixes parallel to gaps
- researchFaults: string[] — gaps because RESEARCH lacks required facts/paths/check proposals
- draftFaults: string[] — gaps because PHASE omitted what RESEARCH already specified

Check ALL of:
1. Required sections present and substantive: ## Scope, ## File Changes, ## Success Criteria, ## Automated Checks (bash fence), ## Blueprint Deltas — not placeholder/scaffold text.
2. RESEARCH translation — file paths, routes, checks, and design decisions from RESEARCH appear in PHASE (especially Automated Checks).
3. uiMount — when intent uiMount is set, PHASE Scope/File Changes name the concrete mount (route/page/component), not abstract "wire auth".
4. Automated Checks — finite structural proofs (grep/build/vitest one-shot); no bare dev servers or npm test without path. Checks must NOT restart infra with docker compose up or trap teardown — SlopControl test-services already brings up Postgres/Redis/etc.; DB-dependent checks assume services are up (migrate/seed/targeted vitest). Redundant infra bring-up is a draft fault.
5. Blueprint Deltas — durable decisions recorded when PHASE introduces new routes/surfaces/contracts.

Interaction contract rules:
- When Change Intent has NO interaction block, do NOT require Playwright fill/submit or form engagement proofs — grep/route/href proofs suffice for page mounts.
- When interaction primaryAction is submit form, Success Criteria + Automated Checks must prove fill+submit at the locked mount.

Verdict rules:
- ok=true only when PHASE is ready for operator review and development.
- Attribute each gap to researchFaults OR draftFaults (can be both lists non-empty).
- When in doubt, prefer ok=false (fail closed).`;

export interface JudgePhaseDocQualityOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  intentBlock: string;
  phaseDescription: string;
  researchExcerpt: string;
  phaseDocExcerpt: string;
  timeoutMs?: number;
}

const EXCERPT_TAIL_CHARS = 16_000;

function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

export function parsePhaseDocQualityVerdictPayload(
  parsed: unknown,
): PhaseDocQualityVerdict {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const pickStrings = (key: string) =>
    Array.isArray(asObj[key])
      ? (asObj[key] as unknown[]).filter(
          (g): g is string => typeof g === "string" && g.trim() !== "",
        )
      : [];
  const gaps = pickStrings("gaps");
  const suggestedFixes = pickStrings("suggestedFixes");
  const researchFaults = pickStrings("researchFaults");
  const draftFaults = pickStrings("draftFaults");
  const okIsBool = typeof asObj.ok === "boolean";
  const ok = okIsBool ? asObj.ok : false;
  return PhaseDocQualityVerdictSchema.parse({
    ok,
    gaps:
      gaps.length > 0
        ? gaps
        : okIsBool
          ? []
          : ["PHASE quality could not be verified (unreadable judge verdict)"],
    suggestedFixes,
    researchFaults,
    draftFaults,
  });
}

export async function judgePhaseDocQualityViaLlm(
  opts: JudgePhaseDocQualityOptions,
): Promise<PhaseDocQualityVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
    maxTokens: CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
    system: PHASE_DOC_QUALITY_SYSTEM_PROMPT,
    user: [
      "Change Intent (authoritative):",
      opts.intentBlock,
      "",
      "Phase description:",
      clip(opts.phaseDescription ?? "", 4_000),
      "",
      "RESEARCH.md excerpt:",
      clip(opts.researchExcerpt ?? "", EXCERPT_TAIL_CHARS),
      "",
      "PHASE.md excerpt (Scope / Success Criteria / Automated Checks / Blueprint Deltas):",
      clip(opts.phaseDocExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parsePhaseDocQualityVerdictPayload(parsed);
}
