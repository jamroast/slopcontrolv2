import {
  validateBlockingOpenQuestions,
  type BlockingOpenQuestion,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const PLAN_PROMOTE_GATE_SYSTEM_PROMPT = `You judge whether the open questions of an accepted plan require an OPERATOR DECISION before development may start.

An open question is BLOCKING when its answer is a product, scope, or policy choice only the operator can make — which of several options to build, which vocabulary/permission/naming to adopt, whether a route stays gated or opens. Investigating the repository cannot answer it; guessing it and being corrected at review wastes the whole run.

An open question is NOT blocking when research in the repo can resolve it: locating files or symbols, verifying current behavior, confirming versions/config, measuring state, checking whether something exists.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY JSON of the shape:
{ "blocking": [ { "question": "<exact string copied from the input list>", "reason": "<one sentence>" } ] }

Rules:
- Copy each flagged question EXACTLY from the input list — never invent, paraphrase, or merge entries.
- A question that names options for the operator to pick (fold vs add, option A vs B, "stop until resolved", "pending an operator decision") is BLOCKING.
- When no question needs an operator decision, return { "blocking": [] }.`;

export async function classifyBlockingOpenQuestionsViaLlm(opts: {
  endpoint: LlmEndpoint;
  modelId?: string;
  goal: string;
  openQuestions: string[];
  timeoutMs?: number;
}): Promise<{ blocking: BlockingOpenQuestion[] }> {
  const user = [
    "Plan goal (context):",
    opts.goal.slice(0, 1_500),
    "",
    "Open questions (judge each — copy flagged ones EXACTLY):",
    ...opts.openQuestions.map((q, i) => `${i + 1}. ${q}`),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: PLAN_PROMOTE_GATE_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  // Deterministically validated; throws (fail closed) on drift.
  return { blocking: validateBlockingOpenQuestions(opts.openQuestions, parsed) };
}
