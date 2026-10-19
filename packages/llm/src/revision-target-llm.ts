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
- intent: true when feedback changes what the phase must deliver or must not do — including a retracted prohibition, a route or file the phase should use, or a goal change — even when the operator does not name INTENT.json. Also true when feedback explicitly edits title, goal, uiMount, mustNot, or researchNote. False when feedback only changes automated checks, file-edit mechanics, or research evidence.

You are given the feedback plus short excerpts of both docs. Judge by content, not by which filename the operator happened to mention.`;

export interface ClassifyRevisionTargetOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  feedback: string;
  researchExcerpt: string;
  phaseExcerpt: string;
  timeoutMs?: number;
  /** Retry with this endpoint when the primary returns unusable output. */
  fallback?: { endpoint: LlmEndpoint; modelId?: string };
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

  const run = async (
    endpoint: LlmEndpoint,
    modelId?: string,
  ): Promise<RevisionClassification> => {
    const { parsed } = await chatJson({
      endpoint,
      modelId,
      system: REVISION_TARGET_SYSTEM_PROMPT,
      user,
      timeoutMs: opts.timeoutMs ?? 90_000,
      temperature: 0,
      schema: RevisionTargetSchema,
      schemaHint:
        'Return ONE object: {"targets":"research"|"phase"|"both","intent":true|false} — never an array',
    });
    return RevisionTargetSchema.parse(parsed);
  };

  try {
    return await run(opts.endpoint, opts.modelId);
  } catch (err) {
    if (!opts.fallback) throw err;
    return run(opts.fallback.endpoint, opts.fallback.modelId);
  }
}
