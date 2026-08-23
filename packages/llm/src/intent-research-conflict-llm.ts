import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const IntentResearchConflictSchema = z.object({
  /** True when research explicitly rejects or overrides wording in the intent. */
  hasConflict: z.boolean(),
  /** The intent wording research rejects (verbatim, e.g. "--packages=external"). */
  rejectedWording: z.string().optional(),
  /** One-sentence description of the research-backed correction. */
  correction: z.string().optional(),
});

export type IntentResearchConflict = z.infer<typeof IntentResearchConflictSchema>;

export const INTENT_RESEARCH_CONFLICT_SYSTEM_PROMPT = `You detect when a phase's RESEARCH.md explicitly contradicts the operator's stated Change Intent.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- hasConflict: boolean
- rejectedWording: optional string — the exact intent wording research rejects (e.g. a build flag, file path, or approach the intent names)
- correction: optional one-sentence summary of the research-backed alternative

Meaning:
- hasConflict=true only when research EXPLICITLY says the intent wording is wrong/unsafe/stale ("do not use X", "X is not safe", "intent says X but package.json does not", "instead of X use Y"). Research merely adding detail or agreeing with the intent is NOT a conflict.
- Judge intent, not keywords. If research restates the intent in different words without contradicting it, hasConflict=false.
- rejectedWording must be copied verbatim from the intent text when hasConflict=true.
`;

export interface ClassifyIntentResearchConflictOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  intentText: string;
  research: string;
  timeoutMs?: number;
}

export async function classifyIntentResearchConflict(
  opts: ClassifyIntentResearchConflictOptions,
): Promise<IntentResearchConflict> {
  const user = [
    "Change Intent (operator's stated ask):",
    opts.intentText.slice(0, 2_000),
    "",
    "RESEARCH.md (excerpt):",
    opts.research.slice(0, 6_000),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: INTENT_RESEARCH_CONFLICT_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return IntentResearchConflictSchema.parse(parsed);
}
