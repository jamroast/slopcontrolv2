import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import {
  chatJson,
  CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
  CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
} from "./json-chat.js";

export const DocRevisionJudgeSchema = z.object({
  applied: z.array(z.string()),
  missing: z.array(z.string()),
});

export type DocRevisionJudgeResult = z.infer<typeof DocRevisionJudgeSchema>;

export const DOC_REVISION_JUDGE_SYSTEM_PROMPT = `You judge whether a document revision actually applied the operator's review feedback.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- applied: array of strings — the feedback bullets that ARE reflected in the revised document.
- missing: array of strings — the feedback bullets that are NOT reflected (substantive, not cosmetic).

Meaning:
- Break the feedback into its substantive bullets first.
- A bullet is "applied" if the revised document reflects it (even partially, in spirit).
- A bullet is "missing" only if it is substantive and genuinely absent.
- If the document is byte-identical to the original, a bullet is "applied" only if the original ALREADY satisfied it (e.g. "confirm env keys are present" when they already are). Otherwise it is "missing".
- Ignore trivial wording differences; judge intent, not exact phrasing.
- When the document is INTENT.json, only goal, rawDescription, and mustNot are in scope. A bullet about automated checks, file edits, or research evidence is applied when those intent fields do not need to change. A bullet that changes what the phase delivers, or retracts a prohibition, is missing if rawDescription or mustNot still states the old contract.`;

export interface JudgeDocRevisionOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  feedback: string;
  before: string;
  after: string;
  timeoutMs?: number;
  /** Retry with this endpoint when the primary returns unusable output. */
  fallback?: { endpoint: LlmEndpoint; modelId?: string };
}

export async function judgeDocRevisionViaLlm(
  opts: JudgeDocRevisionOptions,
): Promise<DocRevisionJudgeResult> {
  const user = [
    "Operator review feedback:",
    opts.feedback,
    "",
    "=== ORIGINAL document ===",
    opts.before || "(empty)",
    "",
    "=== REVISED document ===",
    opts.after || "(empty)",
  ].join("\n");

  const run = async (
    endpoint: LlmEndpoint,
    modelId?: string,
  ): Promise<DocRevisionJudgeResult> => {
    const { parsed } = await chatJson({
      endpoint,
      modelId,
      system: DOC_REVISION_JUDGE_SYSTEM_PROMPT,
      user,
      timeoutMs: opts.timeoutMs ?? CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
      maxTokens: CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
      temperature: 0,
      schema: DocRevisionJudgeSchema,
      schemaHint:
        'Return ONE object: {"applied":string[],"missing":string[]} — never an array',
    });
    return DocRevisionJudgeSchema.parse(parsed);
  };

  try {
    return await run(opts.endpoint, opts.modelId);
  } catch (err) {
    if (!opts.fallback) throw err;
    return run(opts.fallback.endpoint, opts.fallback.modelId);
  }
}
