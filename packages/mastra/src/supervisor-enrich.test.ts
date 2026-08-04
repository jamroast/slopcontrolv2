import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IterationMemoryEntry } from "@slopcontrol/types";
import {
  SUPERVISOR_PROMPT_SOFT_BUDGET,
  buildSupervisorEnrichPrompt,
  extractNextActionsSummary,
  isPromptTooLongError,
  priorNextActionsFromMemory,
  resolveAgentMemoryOption,
} from "./supervisor-enrich.js";

describe("resolveAgentMemoryOption", () => {
  it("returns undefined when memory is false", () => {
    assert.equal(
      resolveAgentMemoryOption("proj", "run-1", false),
      undefined,
    );
  });

  it("defaults to resource/thread when memory omitted", () => {
    assert.deepEqual(resolveAgentMemoryOption("proj", "run-1"), {
      resource: "proj",
      thread: "run-1",
    });
  });

  it("passes through explicit memory object", () => {
    assert.deepEqual(
      resolveAgentMemoryOption("proj", "run-1", {
        resource: "r",
        thread: "t",
      }),
      { resource: "r", thread: "t" },
    );
  });
});

describe("buildSupervisorEnrichPrompt", () => {
  const base = {
    iteration: 2,
    diagnosisStreak: 1,
    maxDiagnosisStreak: 3,
    noProgressCount: 0,
    maxNoProgress: 5,
    infraStrikeCount: 0,
    planCoverageSummary: "on track",
    diagnosisCard: "## Failure diagnosis\nclass=process\nfailingStep=automatedCheck",
    phaseExcerpt: "# PHASE\n## Automated Checks\ndo the thing",
    worktreePath: "/tmp/wt",
    runId: "run-abc",
    phaseId: "03-externalise",
    checkSignal: "FAILING STEP: automatedCheck\nexitCode: 1\nAssertionError: expected",
    learningsBlock: "### Learnings\n- fix PHASE.md first",
    priorNextActions: [
      "## Next actions\nEdit PHASE.md check fence",
      "## Next actions\nRe-run verify on failing step",
    ],
  };

  it("includes diagnosis, check signal, prior next-actions, and checks dir", () => {
    const { prompt, clipped, charCount } = buildSupervisorEnrichPrompt(base);
    assert.equal(clipped, false);
    assert.ok(charCount > 0);
    assert.match(prompt, /Failure diagnosis/);
    assert.match(prompt, /FAILING STEP: automatedCheck/);
    assert.match(prompt, /Prior supervisor next-actions/);
    assert.match(prompt, /Edit PHASE\.md check fence/);
    assert.match(prompt, /\.slopcontrol\/runs\/run-abc\/checks\//);
    assert.match(prompt, /do not ask for full logs/i);
    assert.doesNotMatch(prompt, /observationalMemory|toolCallId|OpenCode/);
  });

  it("excludes multi-MB noise and stays under budget when prior blobs are huge", () => {
    const huge = "X".repeat(2_000_000);
    const { prompt, clipped, charCount } = buildSupervisorEnrichPrompt({
      ...base,
      priorNextActions: [huge, huge, huge],
      learningsBlock: huge,
      phaseExcerpt: huge,
      checkSignal: huge,
      softBudget: 8_000,
    });
    assert.equal(clipped, true);
    assert.ok(charCount <= 8_000 + 80);
    assert.ok(prompt.length < 50_000);
    assert.match(prompt, /Failure diagnosis/);
    assert.doesNotMatch(prompt, new RegExp("X".repeat(20_000)));
  });

  it("stays under default soft budget with oversized inputs", () => {
    const big = "Y".repeat(200_000);
    const { prompt, charCount } = buildSupervisorEnrichPrompt({
      ...base,
      priorNextActions: [big, big, big],
      learningsBlock: big,
      phaseExcerpt: big,
      checkSignal: big,
    });
    assert.ok(charCount <= SUPERVISOR_PROMPT_SOFT_BUDGET);
    assert.ok(prompt.length <= SUPERVISOR_PROMPT_SOFT_BUDGET);
  });
});

describe("extractNextActionsSummary / priorNextActionsFromMemory", () => {
  it("extracts ## Next actions section", () => {
    const out = extractNextActionsSummary(`Preamble

## Next actions
1. Fix the check
2. Re-run verify

## Other
ignore`);
    assert.match(out, /Fix the check/);
    assert.doesNotMatch(out, /ignore/);
  });

  it("reads last N summaries from memory", () => {
    const entries: IterationMemoryEntry[] = [
      {
        iteration: 1,
        status: "build_failed",
        errorCount: 1,
        errorHash: "a",
        noProgressStreak: 0,
        timestamp: "2026-08-02T00:00:00.000Z",
        details: "x",
        nextActionsSummary: "## Next actions\none",
      },
      {
        iteration: 2,
        status: "build_failed",
        errorCount: 1,
        errorHash: "b",
        noProgressStreak: 1,
        timestamp: "2026-08-02T00:01:00.000Z",
        details: "y",
      },
      {
        iteration: 3,
        status: "build_failed",
        errorCount: 1,
        errorHash: "c",
        noProgressStreak: 2,
        timestamp: "2026-08-02T00:02:00.000Z",
        details: "z",
        nextActionsSummary: "## Next actions\nthree",
      },
    ];
    const prior = priorNextActionsFromMemory(entries, 3);
    assert.deepEqual(prior, [
      "## Next actions\none",
      "## Next actions\nthree",
    ]);
  });
});

describe("isPromptTooLongError", () => {
  it("detects Ollama-style prompt too long", () => {
    assert.equal(
      isPromptTooLongError(
        new Error("The prompt is too long: 906904 > 524288"),
      ),
      true,
    );
    assert.equal(isPromptTooLongError(new Error("timeout")), false);
  });
});
