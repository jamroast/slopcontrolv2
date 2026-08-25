import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

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
- Ignore trivial wording differences; judge intent, not exact phrasing.`;

export interface JudgeDocRevisionOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  feedback: string;
  before: string;
  after: string;
  timeoutMs?: number;
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

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: DOC_REVISION_JUDGE_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return DocRevisionJudgeSchema.parse(parsed);
}
