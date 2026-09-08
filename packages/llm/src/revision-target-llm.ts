import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const RevisionTargetSchema = z.object({
  targets: z.enum(["research", "phase", "both"]),
  intent: z.boolean().optional(),
});

export type RevisionTarget = z.infer<typeof RevisionTargetSchema>["targets"];
export type RevisionClassification = z.infer<typeof RevisionTargetSchema>;

export const REVISION_TARGET_SYSTEM_PROMPT = `You decide which planning artifact(s) operator review feedback should revise: RESEARCH.md, PHASE.md, or both, and whether it also revises INTENT.json.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- targets: "research" | "phase" | "both"
- intent: boolean (optional, default false)

Meaning:
- "research": feedback is about research conclusions, evidence, root-cause hypotheses, or sections that live in RESEARCH.md (e.g. "fold into research", "the auth section in research", "blueprint deltas in research").
- "phase": feedback is about the execution contract — Scope, File Changes, Automated Checks, Blueprint Deltas, Success Criteria — which live in PHASE.md.
- "both": feedback touches research conclusions AND the phase contract, or is ambiguous. When in doubt, choose "both" (revising both is never wrong).
- intent: true when feedback asks to edit INTENT.json metadata — the change intent's title, goal, uiMount, mustNot list, researchNote, or other intent fields (e.g. "drop the stale mustNot entries", "dedupe researchNote", "change the goal", "the intent says X"). INTENT.json is a separate metadata file from RESEARCH.md/PHASE.md; set intent=true when the feedback names it or asks to edit intent fields.

You are given the feedback plus short excerpts of both docs. Judge by content, not by which filename the operator happened to mention.`;

export interface ClassifyRevisionTargetOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  feedback: string;
  researchExcerpt: string;
  phaseExcerpt: string;
  timeoutMs?: number;
}

export async function classifyRevisionTargetsViaLlm(
  opts: ClassifyRevisionTargetOptions,
): Promise<RevisionClassification> {
  const user = [
    "Operator review feedback:",
    opts.feedback,
    "",
    "RESEARCH.md excerpt:",
    opts.researchExcerpt || "(empty)",
    "",
    "PHASE.md excerpt:",
    opts.phaseExcerpt || "(empty)",
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: REVISION_TARGET_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return RevisionTargetSchema.parse(parsed);
}
