import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FailureDiagnosis } from "@slopcontrol/artifacts";
import {
  buildDevelopProductInvestigatePrompt,
  shouldRunDevelopProductInvestigation,
} from "./develop-failure-investigate.js";

function productDiagnosis(
  overrides: Partial<FailureDiagnosis> = {},
): FailureDiagnosis {
  return {
    audience: "coding",
    class: "product",
    confidence: "high",
    codingAgentShouldFix: true,
    evidence: "expected 200 got 400",
    fingerprint: "fp-test",
    harnessRecoverable: false,
    nextActions: "Fix token exchange handler in src/provider.ts",
    operatorActions: [],
    rootCause: "token exchange rejects DPoP proof",
    title: "DPoP token exchange returns 400",
    ...overrides,
  };
}

describe("shouldRunDevelopProductInvestigation", () => {
  it("runs once for product failures with no file changes", () => {
    assert.equal(
      shouldRunDevelopProductInvestigation({
        diagnosis: productDiagnosis(),
        lastIterationHadFileChanges: false,
        lastIterationZeroPlanProgress: false,
        alreadyInvestigated: false,
      }),
      true,
    );
  });

  it("runs when planned paths were never touched", () => {
    assert.equal(
      shouldRunDevelopProductInvestigation({
        diagnosis: productDiagnosis(),
        lastIterationHadFileChanges: true,
        lastIterationZeroPlanProgress: true,
        alreadyInvestigated: false,
      }),
      true,
    );
  });

  it("skips infra and already-investigated fingerprints", () => {
    assert.equal(
      shouldRunDevelopProductInvestigation({
        diagnosis: productDiagnosis({ class: "infra" }),
        lastIterationHadFileChanges: false,
        lastIterationZeroPlanProgress: false,
        alreadyInvestigated: false,
      }),
      false,
    );
    assert.equal(
      shouldRunDevelopProductInvestigation({
        diagnosis: productDiagnosis({ codingAgentShouldFix: false }),
        lastIterationHadFileChanges: false,
        lastIterationZeroPlanProgress: false,
        alreadyInvestigated: false,
      }),
      false,
    );
    assert.equal(
      shouldRunDevelopProductInvestigation({
        diagnosis: productDiagnosis(),
        lastIterationHadFileChanges: false,
        lastIterationZeroPlanProgress: false,
        alreadyInvestigated: true,
      }),
      false,
    );
  });

  it("skips when files changed and plan progress exists", () => {
    assert.equal(
      shouldRunDevelopProductInvestigation({
        diagnosis: productDiagnosis(),
        lastIterationHadFileChanges: true,
        lastIterationZeroPlanProgress: false,
        alreadyInvestigated: false,
      }),
      false,
    );
  });
});

describe("buildDevelopProductInvestigatePrompt", () => {
  it("includes diagnosis, verify excerpt, and missing planned paths", () => {
    const prompt = buildDevelopProductInvestigatePrompt({
      worktreePath: "/tmp/wt",
      phaseId: "39-x",
      diagnosis: productDiagnosis(),
      verifyExcerpt: "expected 200 got 400\nAssertionError",
      missingPlannedPaths: ["src/provider.ts"],
      endpoint: {
        id: "test",
        baseUrl: "http://x",
        apiType: "openai-chat",
        modelId: "test-model",
      },
    });
    assert.match(prompt, /DPoP token exchange returns 400/);
    assert.match(prompt, /expected 200 got 400/);
    assert.match(prompt, /src\/provider\.ts/);
    assert.match(prompt, /markdown findings only/i);
  });
});
