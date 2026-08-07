import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFailureDiagnosis,
  buildFailureDiagnosisAsync,
  extractFailureSignals,
  mergeLlmFailureClassification,
  type ClassifyVerifyFailureFn,
} from "./failure-classify.js";

const PRODUCT_FAILURE_OUTPUT = [
  "FAIL src/auth/login.test.ts > issues the session cookie",
  "AssertionError: expected true to be false",
  "  at src/auth/login.test.ts:42:11",
].join("\n");

const STEP = {
  name: "test",
  command: "npm test",
  exitCode: 1,
  output: PRODUCT_FAILURE_OUTPUT,
};

describe("buildFailureDiagnosisAsync", () => {
  it("short-circuits on the deterministic fast-path before any LLM call", async () => {
    let llmCalls = 0;
    const classifyFn: ClassifyVerifyFailureFn = async () => {
      llmCalls += 1;
      throw new Error("must not be called");
    };
    const diagnosis = await buildFailureDiagnosisAsync(
      {
        output: "automated-check: CHECK_TIMEOUT after 120000ms — step killed",
        firstFailure: {
          name: "automated-check",
          command: "pnpm dev & sleep 5",
          exitCode: 124,
          output: "CHECK_TIMEOUT after 120000ms — step killed",
        },
      },
      { classifyFn },
    );
    assert.equal(llmCalls, 0);
    assert.equal(diagnosis.class, "process");
    assert.ok(diagnosis.tags?.includes("check-timeout"));
  });

  it("lets the LLM class win for semantic cases", async () => {
    const classifyFn: ClassifyVerifyFailureFn = async () => ({
      class: "infra",
      confidence: "high",
      summary: "Postgres connection refused on localhost:5432 — tests never ran.",
      tags: ["db", "connection-refused"],
      codingAgentShouldFix: false,
      audience: "operator",
      operatorActions: ["Start the database container."],
      lesson: "Start the DB container before db-dependent steps.",
    });
    const diagnosis = await buildFailureDiagnosisAsync(
      { output: PRODUCT_FAILURE_OUTPUT, firstFailure: STEP },
      { classifyFn },
    );
    assert.equal(diagnosis.class, "infra");
    assert.equal(diagnosis.title, "Postgres connection refused on localhost:5432 — tests never ran.");
    assert.equal(diagnosis.audience, "operator");
    assert.equal(diagnosis.codingAgentShouldFix, false);
    assert.deepEqual(diagnosis.operatorActions, ["Start the database container."]);
    assert.ok(diagnosis.tags?.includes("db"));
    assert.ok(diagnosis.tags?.includes("llm"));
  });

  it("supplies class-default operator actions when the LLM gives none", async () => {
    const classifyFn: ClassifyVerifyFailureFn = async () => ({
      class: "infra",
      confidence: "medium",
      summary: "Runtime dependency unavailable.",
      codingAgentShouldFix: false,
      audience: "operator",
    });
    const diagnosis = await buildFailureDiagnosisAsync(
      { output: PRODUCT_FAILURE_OUTPUT, firstFailure: STEP },
      { classifyFn },
    );
    assert.equal(diagnosis.audience, "operator");
    assert.ok(diagnosis.operatorActions.length > 0);
  });

  it("falls back to identical sync output (plus llm-fallback tag) when the classifier throws", async () => {
    const input = { output: PRODUCT_FAILURE_OUTPUT, firstFailure: STEP };
    const sync = buildFailureDiagnosis(input);
    const classifyFn: ClassifyVerifyFailureFn = async () => {
      throw new Error("endpoint down");
    };
    const diagnosis = await buildFailureDiagnosisAsync(input, { classifyFn });
    assert.deepEqual(
      { ...diagnosis, tags: undefined },
      { ...sync, tags: undefined },
    );
    assert.deepEqual(diagnosis.tags, [...(sync.tags ?? []), "llm-fallback"]);
  });

  it("is byte-identical to sync when no classifyFn is supplied", async () => {
    const input = { output: PRODUCT_FAILURE_OUTPUT, firstFailure: STEP };
    const sync = buildFailureDiagnosis(input);
    const diagnosis = await buildFailureDiagnosisAsync(input);
    assert.deepEqual(diagnosis, sync);
  });

  it("keeps fingerprints stable between sync refresh and async paths for identical classifications", async () => {
    // Stored-evidence refresh (handoff) stays sync; a fallback async diagnosis
    // of the same evidence must produce the same fingerprint.
    const input = { output: PRODUCT_FAILURE_OUTPUT, firstFailure: STEP };
    const sync = buildFailureDiagnosis(input);
    const classifyFn: ClassifyVerifyFailureFn = async () => {
      throw new Error("offline");
    };
    const diagnosis = await buildFailureDiagnosisAsync(input, { classifyFn });
    assert.equal(diagnosis.fingerprint, sync.fingerprint);

    const noLlm = await buildFailureDiagnosisAsync(input);
    assert.equal(noLlm.fingerprint, sync.fingerprint);
  });
});

describe("mergeLlmFailureClassification", () => {
  it("forces operatorActions=[] when the coding agent should fix", () => {
    const merged = mergeLlmFailureClassification({
      class: "process",
      confidence: "high",
      summary: "Broken Automated Check: trailing line continuation.",
      codingAgentShouldFix: true,
      audience: "coding",
      operatorActions: ["should be dropped"],
    });
    assert.equal(merged.audience, "coding");
    assert.deepEqual(merged.operatorActions, []);
  });

  it("maps unknown/garbage classes to unknown", () => {
    const merged = mergeLlmFailureClassification({
      class: "cosmic-rays",
      summary: "Something failed.",
    });
    assert.equal(merged.class, "unknown");
    assert.equal(merged.learning?.kind, "process");
  });

  it("sanitizes tags and always appends the llm marker", () => {
    const merged = mergeLlmFailureClassification({
      class: "env",
      summary: "OLLAMA_API_KEY missing.",
      codingAgentShouldFix: false,
      audience: "operator",
      tags: ["missing-env", "", "  ", "ollama", "missing-env"],
    });
    assert.deepEqual(merged.tags, ["missing-env", "ollama", "llm"]);
  });

  it("derives codingAgentShouldFix from audience when unset", () => {
    const op = mergeLlmFailureClassification({
      class: "infra",
      summary: "x",
      audience: "operator",
    });
    assert.equal(op.codingAgentShouldFix, false);
    const coding = mergeLlmFailureClassification({
      class: "product",
      summary: "x",
      audience: "coding",
    });
    assert.equal(coding.codingAgentShouldFix, true);
  });

  it("falls back to a generic lesson when the LLM omits one", () => {
    const merged = mergeLlmFailureClassification({
      class: "product",
      summary: "Assertion failed.",
    });
    assert.ok(merged.learning?.lesson.includes("product"));
  });
});

describe("extractFailureSignals", () => {
  it("extracts the missing node bin and exit code", () => {
    const signals = extractFailureSignals("sh: vite: command not found", {
      exitCode: 127,
      command: "npm run build",
      stepName: "build",
    });
    assert.equal(signals.missingCommandKind, "node-bin");
    assert.equal(signals.missingCommand, "vite");
    assert.equal(signals.exitCode, 127);
  });

  it("detects CHECK_TIMEOUT, HTTP status and connection refusal", () => {
    const timeout = extractFailureSignals("CHECK_TIMEOUT after 60000ms");
    assert.equal(timeout.checkTimeout, true);

    const http = extractFailureSignals("chat smoke failed: HTTP 429 too many requests");
    assert.equal(http.httpStatus, 429);

    const refused = extractFailureSignals("connect ECONNREFUSED 127.0.0.1:5432");
    assert.equal(refused.connectionRefused, true);
  });

  it("reports null missing-command fields when no command was parsed", () => {
    const signals = extractFailureSignals("AssertionError: expected 1 to be 2");
    assert.equal(signals.missingCommandKind, null);
    assert.equal(signals.missingCommand, null);
  });
});
