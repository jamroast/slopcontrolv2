import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseVerifyFailureLlmPayload,
  rerouteSilentCheckFailure,
  type VerifyFailureLlmResult,
} from "./verify-failure-llm.js";

function baseResult(
  overrides: Partial<VerifyFailureLlmResult> = {},
): VerifyFailureLlmResult {
  return {
    class: "infra",
    confidence: "medium",
    summary: "hallucinated auth story",
    tags: ["auth"],
    codingAgentShouldFix: false,
    audience: "operator",
    operatorActions: ["Set a real token"],
    ...overrides,
  };
}

describe("rerouteSilentCheckFailure", () => {
  it("re-routes empty-output infra/operator misdiagnoses to the coding agent", () => {
    // Observed 2026-09-28: an env-fragile grep check (exit 1, empty output)
    // was misdiagnosed as a GitHub Packages auth rejection, parking the run.
    const out = rerouteSilentCheckFailure(baseResult(), {
      output: "",
      exitCode: 1,
    });
    assert.equal(out.class, "process");
    assert.equal(out.audience, "coding");
    assert.equal(out.codingAgentShouldFix, true);
    assert.equal(out.confidence, "low");
    assert.deepEqual(out.operatorActions, []);
    assert.match(out.summary, /no output/i);
  });

  it("treats whitespace-only output as empty", () => {
    const out = rerouteSilentCheckFailure(baseResult(), {
      output: "  \n  ",
      exitCode: 1,
    });
    assert.equal(out.class, "process");
    assert.equal(out.codingAgentShouldFix, true);
  });

  it("re-routes env/model classes too when output is empty", () => {
    for (const cls of ["env", "model"] as const) {
      const out = rerouteSilentCheckFailure(baseResult({ class: cls }), {
        output: "",
        exitCode: 1,
      });
      assert.equal(out.class, "process", cls);
      assert.equal(out.audience, "coding");
    }
  });

  it("leaves evidence-backed infra diagnoses untouched", () => {
    const input = baseResult({ summary: "connect ECONNREFUSED 127.0.0.1:5432" });
    const out = rerouteSilentCheckFailure(input, {
      output: "npm error code ECONNREFUSED\nnpm error connect ECONNREFUSED 127.0.0.1:5432",
      exitCode: 1,
    });
    assert.deepEqual(out, input);
  });

  it("leaves silent product/process failures routed to coding untouched", () => {
    const input = baseResult({
      class: "product",
      audience: "coding",
      codingAgentShouldFix: true,
      operatorActions: [],
    });
    const out = rerouteSilentCheckFailure(input, { output: "", exitCode: 1 });
    assert.deepEqual(out, input);
  });

  it("re-routes operator audience even when the class is ambiguous", () => {
    const out = rerouteSilentCheckFailure(
      baseResult({ class: "unknown" }),
      { output: "", exitCode: 1 },
    );
    assert.equal(out.class, "process");
    assert.equal(out.audience, "coding");
  });
});

describe("parseVerifyFailureLlmPayload", () => {
  it("defaults messy payloads to coding-routed unknown", () => {
    const out = parseVerifyFailureLlmPayload({});
    assert.equal(out.class, "unknown");
    assert.equal(out.audience, "coding");
    assert.equal(out.codingAgentShouldFix, true);
  });
});
