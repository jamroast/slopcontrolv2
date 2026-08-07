import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VERIFY_FAILURE_SYSTEM_PROMPT,
  VerifyFailureClassSchema,
  VerifyFailureLlmSchema,
  parseVerifyFailureLlmPayload,
} from "./verify-failure-llm.js";

describe("verify-failure-llm", () => {
  it("system prompt carries the classification rules", () => {
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /"infra"/);
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /"product"/);
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /"process"/);
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /"model"/);
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /"env"/);
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /"unknown"/);
  });

  it("system prompt forbids free-tier model switching and scopes operator actions", () => {
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /Never recommend switching product models to free-tier IDs/);
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /only when audience is "operator"/);
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /llmTestProfile=local/);
  });

  it("system prompt treats signals as ground truth", () => {
    assert.match(VERIFY_FAILURE_SYSTEM_PROMPT, /ground truth/);
  });

  it("class schema enumerates the failure classes", () => {
    for (const cls of ["infra", "product", "process", "model", "env", "unknown"]) {
      assert.equal(VerifyFailureClassSchema.parse(cls), cls);
    }
    assert.throws(() => VerifyFailureClassSchema.parse("network"));
  });

  it("parses a well-formed payload", () => {
    const result = VerifyFailureLlmSchema.parse({
      class: "infra",
      confidence: "high",
      summary: "Postgres connection refused on localhost:5432.",
      tags: ["db", "connection-refused"],
      codingAgentShouldFix: false,
      audience: "operator",
      operatorActions: ["Start the database container."],
      lesson: "Start the DB container before db steps.",
    });
    assert.equal(result.class, "infra");
    assert.equal(result.audience, "operator");
    assert.deepEqual(result.operatorActions, ["Start the database container."]);
    assert.equal(result.lesson, "Start the DB container before db steps.");
  });

  it("coerces bad confidence to low and missing arrays to []", () => {
    const result = parseVerifyFailureLlmPayload({
      class: "process",
      confidence: "very-high",
      summary: "Check started a long-lived dev server and hit the wall-clock timeout.",
      codingAgentShouldFix: true,
      audience: "coding",
    });
    assert.equal(result.confidence, "low");
    assert.deepEqual(result.tags, []);
    assert.deepEqual(result.operatorActions, []);
    assert.equal(result.lesson, undefined);
  });

  it("coerces unknown class to unknown and derives shouldFix from audience", () => {
    const result = parseVerifyFailureLlmPayload({
      class: "cosmic-rays",
      summary: "Something failed.",
      audience: "operator",
    });
    assert.equal(result.class, "unknown");
    assert.equal(result.codingAgentShouldFix, false);

    const coding = parseVerifyFailureLlmPayload({
      class: "product",
      summary: "Assertion failed in auth.test.ts.",
      audience: "coding",
    });
    assert.equal(coding.codingAgentShouldFix, true);
  });

  it("falls back to a default summary on missing/empty summary", () => {
    const result = parseVerifyFailureLlmPayload({ class: "infra", summary: "   " });
    assert.equal(result.summary, "Verification failed (unclassified).");
  });

  it("filters non-string tags and blank operator actions", () => {
    const result = parseVerifyFailureLlmPayload({
      class: "env",
      summary: "OLLAMA_API_KEY missing.",
      audience: "operator",
      tags: ["missing-env", 42, null, "ollama"],
      operatorActions: ["Set OLLAMA_API_KEY.", "  ", 7],
    });
    assert.deepEqual(result.tags, ["missing-env", "ollama"]);
    assert.deepEqual(result.operatorActions, ["Set OLLAMA_API_KEY."]);
  });

  it("handles a non-object payload", () => {
    const result = parseVerifyFailureLlmPayload("not json");
    assert.equal(result.class, "unknown");
    assert.equal(result.audience, "coding");
    assert.equal(result.codingAgentShouldFix, true);
  });
});
