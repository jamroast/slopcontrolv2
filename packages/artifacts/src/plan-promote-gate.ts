/**
 * Plan-promote gate — keeps a plan loop with unresolved OPERATOR-DECISION
 * open questions from becoming a phase.
 *
 * Research can resolve code-fact questions ("where is X", "does Y exist")
 * with repo evidence, but a question whose answer is a product/scope/policy
 * choice (which option to build, vocabulary to adopt) stalls the pipeline:
 * the phase is born with a self-declared blocking unknown, research guesses
 * an answer, and a human catches the contradiction at review hours later.
 * The gate classifies open questions at promote time and refuses the
 * promotion until the operator answers them (plan_loop_continue → re-accept)
 * or explicitly forces the promote.
 *
 * The classifier output is validated deterministically and fails closed:
 * returned questions must be an exact-string subset of the pack's
 * openQuestions — anything else throws and the promote surfaces the error.
 */

import { z } from "zod";

export const BlockingOpenQuestionSchema = z.object({
  /** Exact string copied from the pack's openQuestions list. */
  question: z.string().min(1),
  /** One sentence on why only the operator can answer it. */
  reason: z.string().default(""),
});
export type BlockingOpenQuestion = z.infer<typeof BlockingOpenQuestionSchema>;

export const BlockingOpenQuestionsSchema = z.object({
  blocking: z.array(BlockingOpenQuestionSchema).default([]),
});
export type BlockingOpenQuestions = z.infer<typeof BlockingOpenQuestionsSchema>;

/**
 * Deterministic validation of the classifier verdict: every flagged question
 * must be an exact member (trimmed) of the pack's openQuestions. Throws on
 * any hallucinated/paraphrased entry so the caller fails closed instead of
 * trusting a drifting judge.
 */
export function validateBlockingOpenQuestions(
  openQuestions: string[],
  parsed: unknown,
): BlockingOpenQuestion[] {
  const { blocking } = BlockingOpenQuestionsSchema.parse(parsed);
  const known = new Set(openQuestions.map((q) => q.trim()));
  for (const b of blocking) {
    if (!known.has(b.question.trim())) {
      throw new Error(
        `Promote gate classifier returned a question that is not in the pack's openQuestions: ${b.question.slice(0, 120)}`,
      );
    }
  }
  return blocking;
}
