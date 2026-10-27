import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BlockingOpenQuestionsSchema,
  validateBlockingOpenQuestions,
} from "./plan-promote-gate.js";

const OPEN_QUESTIONS = [
  "Which vocabulary permission should roles writes gate on — fold under manage_users (option a) or add manage_roles (option b)? Stop before implementation until resolved.",
  "Where does the routes module register env-scoped write routes?",
];

describe("plan-promote-gate", () => {
  it("schema parses a blocking verdict and defaults empty", () => {
    const parsed = BlockingOpenQuestionsSchema.parse({
      blocking: [{ question: OPEN_QUESTIONS[0], reason: "operator choice" }],
    });
    assert.equal(parsed.blocking.length, 1);
    assert.deepEqual(BlockingOpenQuestionsSchema.parse({}).blocking, []);
  });

  it("validation keeps exact-subset verdicts", () => {
    const blocking = validateBlockingOpenQuestions(OPEN_QUESTIONS, {
      blocking: [{ question: OPEN_QUESTIONS[0], reason: "pick an option" }],
    });
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0]!.question, OPEN_QUESTIONS[0]);
  });

  it("validation passes an all-clear verdict", () => {
    assert.deepEqual(
      validateBlockingOpenQuestions(OPEN_QUESTIONS, { blocking: [] }),
      [],
    );
  });

  it("validation throws (fail closed) on a hallucinated question", () => {
    assert.throws(() =>
      validateBlockingOpenQuestions(OPEN_QUESTIONS, {
        blocking: [
          {
            question: "Should the button be blue or green?",
            reason: "invented",
          },
        ],
      }),
    );
  });

  it("validation throws on a paraphrased (non-exact) question", () => {
    assert.throws(() =>
      validateBlockingOpenQuestions(OPEN_QUESTIONS, {
        blocking: [
          {
            // Same semantics, different string — must not be trusted.
            question: "fold roles under manage_users or add manage_roles?",
            reason: "paraphrase",
          },
        ],
      }),
    );
  });

  it("validation throws on malformed payloads", () => {
    assert.throws(() =>
      validateBlockingOpenQuestions(OPEN_QUESTIONS, { blocking: "yes" }),
    );
    assert.throws(() => validateBlockingOpenQuestions(OPEN_QUESTIONS, null));
  });
});
