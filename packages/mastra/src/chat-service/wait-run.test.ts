import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunStage } from "@slopcontrol/types";
import {
  extractBusyRunFromLifecycleResult,
  formatWaitForRunResult,
  isBusyRunStage,
  waitForRun,
  type RunSnapshot,
} from "./wait-run.js";

function snap(stage: RunStage, id = "run-1"): RunSnapshot {
  return { id, stage, phaseId: "ph-1", projectId: "p1" };
}

describe("extractBusyRunFromLifecycleResult", () => {
  it("reads nested run from a start_research 202 body", () => {
    const extracted = extractBusyRunFromLifecycleResult(
      JSON.stringify({
        run: { id: "abc", stage: "researching", phaseId: "ph", projectId: "p" },
        phase: { id: "ph" },
        stage: "researching",
        accepted: true,
      }),
    );
    assert.deepEqual(extracted, { runId: "abc", stage: "researching" });
  });

  it("reads runId at the top level", () => {
    const extracted = extractBusyRunFromLifecycleResult(
      JSON.stringify({ runId: "r2", stage: "developing" }),
    );
    assert.deepEqual(extracted, { runId: "r2", stage: "developing" });
  });

  it("skips leading ERROR prefix", () => {
    const extracted = extractBusyRunFromLifecycleResult(
      `ERROR:\n${JSON.stringify({ run: { id: "x", stage: "researching" } })}`,
    );
    assert.equal(extracted?.runId, "x");
  });

  it("returns null when there is no run id", () => {
    assert.equal(extractBusyRunFromLifecycleResult("not json"), null);
    assert.equal(extractBusyRunFromLifecycleResult("{}"), null);
  });
});

describe("waitForRun", () => {
  it("returns immediately when the run is already settled", async () => {
    const result = await waitForRun({
      runId: "run-1",
      getRun: () => snap("in_review"),
      timeoutMs: 1_000,
      intervalMs: 10,
    });
    assert.equal(result.settled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.stage, "in_review");
  });

  it("polls until the stage leaves the busy set", async () => {
    const stages: RunStage[] = ["researching", "researching", "in_review"];
    const result = await waitForRun({
      runId: "run-1",
      getRun: () => snap(stages.shift() ?? "in_review"),
      timeoutMs: 1_000,
      intervalMs: 10,
    });
    assert.equal(result.settled, true);
    assert.equal(result.stage, "in_review");
    assert.equal(stages.length, 0);
  });

  it("times out while still busy", async () => {
    const result = await waitForRun({
      runId: "run-1",
      getRun: () => snap("researching"),
      timeoutMs: 40,
      intervalMs: 10,
    });
    assert.equal(result.settled, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.stage, "researching");
  });

  it("reports missing when getRun returns undefined", async () => {
    const result = await waitForRun({
      runId: "gone",
      getRun: () => undefined,
      timeoutMs: 50,
      intervalMs: 10,
    });
    assert.equal(result.stage, "missing");
    assert.equal(result.settled, false);
  });
});

describe("formatWaitForRunResult", () => {
  it("tells the model to brief the operator when research lands in_review", () => {
    const text = formatWaitForRunResult({
      runId: "r1",
      stage: "in_review",
      settled: true,
      timedOut: false,
      elapsedMs: 12_000,
    });
    assert.match(text, /in_review/);
    assert.match(text, /ready for operator review/);
    assert.match(text, /advance_run/);
    assert.match(text, /start_development/);
    assert.match(text, /request_changes/);
    assert.ok(!text.includes("still"));
  });

  it("forbids inventing a summary when still busy", () => {
    const text = formatWaitForRunResult({
      runId: "r1",
      stage: "researching",
      settled: false,
      timedOut: true,
      elapsedMs: 90_000,
    });
    assert.match(text, /still researching/);
    assert.match(text, /Do not invent a completion summary/);
  });
});

describe("isBusyRunStage", () => {
  it("treats researching/developing as busy and in_review as settled", () => {
    assert.equal(isBusyRunStage("researching"), true);
    assert.equal(isBusyRunStage("developing"), true);
    assert.equal(isBusyRunStage("in_review"), false);
    assert.equal(isBusyRunStage("complete"), false);
  });
});
