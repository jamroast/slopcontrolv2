import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  writeDevelopmentHandoff,
  type DevelopmentHandoff,
} from "@slopcontrol/artifacts";
import {
  buildRunSettledGuidance,
  buildRunSettledNotification,
} from "./run-settled-notification.js";

function writeHandoff(
  root: string,
  runId: string,
  phaseId: string,
  merge: DevelopmentHandoff["merge"],
): void {
  writeDevelopmentHandoff(root, {
    phaseId,
    runId,
    handoff: {
      outcome: "complete",
      phaseId,
      runId,
      updatedAt: new Date().toISOString(),
      summary: "done",
      requirements: [],
      knowledge: [],
      operatorRequirements: ["Wire env in staging"],
      nextSteps: ["Start next phase"],
      merge,
      source: "orchestrator",
    },
  });
}

describe("run-settled notification", () => {
  it("tells the agent not to offer merge when auto-merge succeeded", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-handoff-"));
    mkdirSync(join(root, ".slopcontrol", "runs", "run-1"), { recursive: true });
    writeHandoff(root, "run-1", "ph-1", {
      autoMerged: true,
      worktreePresent: false,
      branch: "main",
      commit: "abc123456789",
    });

    const guidance = buildRunSettledGuidance(
      { id: "run-1", stage: "complete", projectId: "p1", phaseId: "ph-1" },
      { getProject: () => ({ rootPath: root }) },
    );

    assert.match(guidance, /auto-merged/i);
    assert.match(guidance, /Do NOT ask whether to merge/i);
    assert.match(guidance, /main @ abc12345/);
    assert.match(guidance, /1 operator follow-up note/);

    const note = buildRunSettledNotification(
      { id: "run-1", stage: "complete", projectId: "p1" },
      { getProject: () => ({ rootPath: root }) },
    );
    assert.ok(note.startsWith("[Run run-1 reached complete."));
    assert.ok(note.endsWith("]"));
  });

  it("suggests merge_phase when auto-merge did not run", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-handoff-"));
    mkdirSync(join(root, ".slopcontrol", "runs", "run-2"), { recursive: true });
    writeHandoff(root, "run-2", "ph-2", {
      autoMerged: false,
      worktreePresent: true,
    });

    const guidance = buildRunSettledGuidance(
      { id: "run-2", stage: "complete", projectId: "p1" },
      { getProject: () => ({ rootPath: root }) },
    );

    assert.match(guidance, /merge_phase/i);
    assert.doesNotMatch(guidance, /Do NOT ask whether to merge/i);
  });

  it("defaults to auto-merge enabled when project config is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-handoff-"));
    const guidance = buildRunSettledGuidance(
      { id: "run-3", stage: "complete", projectId: "p1" },
      { getProject: () => ({ rootPath: root }) },
    );
    assert.match(guidance, /autoMergeOnComplete enabled/i);
  });

  it("respects disabled auto-merge project config", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-handoff-"));
    mkdirSync(join(root, ".slopcontrol"), { recursive: true });
    writeFileSync(
      join(root, ".slopcontrol", "config.json"),
      JSON.stringify({ autoMergeOnComplete: false }),
    );

    const guidance = buildRunSettledGuidance(
      { id: "run-4", stage: "complete", projectId: "p1" },
      { getProject: () => ({ rootPath: root }) },
    );
    assert.match(guidance, /autoMergeOnComplete is disabled/i);
  });
});
