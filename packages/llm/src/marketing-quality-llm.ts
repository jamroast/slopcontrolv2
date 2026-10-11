import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import {
  chatJson,
  CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
  CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
} from "./json-chat.js";

/**
 * MARKETING.md quality judge. Fail closed. Evidence faults mean the
 * competitor/landing investigation was thin. Draft faults mean the doc
 * did not use evidence it already had.
 */

export const MarketingQualityVerdictSchema = z.object({
  ok: z.boolean(),
  gaps: z.array(z.string()),
  suggestedFixes: z.array(z.string()),
  evidenceFaults: z.array(z.string()),
  draftFaults: z.array(z.string()),
});

export type MarketingQualityVerdict = z.infer<typeof MarketingQualityVerdictSchema>;

export const MARKETING_QUALITY_SYSTEM_PROMPT = `You are SlopControl's MARKETING.md quality judge. You decide whether a marketing release document is honest enough to accept. Respond with ONLY a single JSON object.

Schema:
- ok: boolean
- gaps: string[] — all issues (empty when ok)
- suggestedFixes: string[] — concrete fixes parallel to gaps
- evidenceFaults: string[] — gaps because the findings never read the current landing or never fetched a competitor source
- draftFaults: string[] — gaps because MARKETING.md ignored evidence it already had

Check ALL of:
1. Required sections are substantive, not stubs: Audience, Competitors, Positioning, Claims, Landing narrative, Tracks, Risks and open questions, Handoff notes.
2. Every claim line is exactly one of proven, gap, or forbidden.
3. A proven claim is backed by a quoted product behavior in the findings or the doc. Confident wording is not proof.
4. A gap claim names the product change. A forbidden claim must not be repeated in the landing narrative.
5. Every gap and forbidden claim id appears on a track. A design track exists for the landing. A product track exists for each gap cluster.
6. Competitor statements cite a source URL that appears in the findings.

Verdict rules:
- ok=true only when the doc can be accepted without inventing proof.
- Attribute each gap to evidenceFaults OR draftFaults (both lists may be non-empty).
- When in doubt, prefer ok=false (fail closed).`;

export interface JudgeMarketingQualityOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  brief: string;
  findings: string;
  doc: string;
  timeoutMs?: number;
}

function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

export function parseMarketingQualityVerdictPayload(
  parsed: unknown,
): MarketingQualityVerdict {
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
  const okIsBool = typeof asObj.ok === "boolean";
  const ok = okIsBool ? (asObj.ok as boolean) : false;
  return MarketingQualityVerdictSchema.parse({
    ok,
    gaps:
      gaps.length > 0
        ? gaps
        : okIsBool
          ? []
          : ["MARKETING quality could not be verified (unreadable judge verdict)"],
    suggestedFixes: pickStrings("suggestedFixes"),
    evidenceFaults: pickStrings("evidenceFaults"),
    draftFaults: pickStrings("draftFaults"),
  });
}

export async function judgeMarketingQualityViaLlm(
  opts: JudgeMarketingQualityOptions,
): Promise<MarketingQualityVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
    maxTokens: CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
    system: MARKETING_QUALITY_SYSTEM_PROMPT,
    user: [
      "Operator brief:",
      clip(opts.brief ?? "", 4_000),
      "",
      "Investigation findings:",
      clip(opts.findings ?? "", 12_000),
      "",
      "MARKETING.md:",
      clip(opts.doc ?? "", 16_000),
    ].join("\n"),
  });
  return parseMarketingQualityVerdictPayload(parsed);
}
