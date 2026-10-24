import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recordStageTransition } from "@slopcontrol/types";
import { SlopStore } from "./store.js";

describe("reconcileInterruptedRuns", () => {
  function makeStore(dir: string) {
    return new SlopStore(join(dir, "store.json"));
  }

  function makeProject(store: SlopStore, dir: string) {
    const projectRoot = join(dir, "proj");
    mkdirSync(projectRoot, { recursive: true });
    const project = store.createProject({ name: "p", rootPath: projectRoot });
    const phase = store.createPhase({
      projectId: project.id,
      description: "Reconcile me",
      rootPath: projectRoot,
    });
    return { project, phase };
  }

  it("marks a busy-stage run interrupted and closes its open timing", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-recon-"));
    try {
      const store = makeStore(dir);
      const { project, phase } = makeProject(store, dir);
      const run = store.createRun({
        phaseId: phase.id,
        projectId: project.id,
      });
      // Simulate a run that died mid-development: busy stage + open timing.
      recordStageTransition(run, "developing", new Date("2026-01-01T00:00:00Z"));
      store.updateRun(run);

      const reconciled = store.reconcileInterruptedRuns(
        new Date("2026-01-01T00:05:00Z"),
      );
      assert.equal(reconciled.length, 1);
      assert.equal(reconciled[0]!.runId, run.id);
      assert.equal(reconciled[0]!.previousStage, "developing");

      const after = store.getRun(run.id)!;
      assert.equal(after.stage, "interrupted");
      assert.ok(after.finishedAt);
      assert.equal(after.totalDurationMs, 5 * 60 * 1000);
      const last = after.stageTimings[after.stageTimings.length - 1]!;
      assert.ok(last.endedAt, "no open timing should survive reconciliation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles every busy variant (researching/drafting/designing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-recon-busy-"));
    try {
      const store = makeStore(dir);
      const { project, phase } = makeProject(store, dir);
      const busyStages = ["researching", "drafting", "designing"] as const;
      const ids = busyStages.map((stage) => {
        const run = store.createRun({ phaseId: phase.id, projectId: project.id });
        recordStageTransition(run, stage, new Date("2026-01-01T00:00:00Z"));
        store.updateRun(run);
        return { id: run.id, stage };
      });

      const reconciled = store.reconcileInterruptedRuns(
        new Date("2026-01-01T00:01:00Z"),
      );
      assert.equal(reconciled.length, 3);
      for (const { id } of ids) {
        assert.equal(store.getRun(id)!.stage, "interrupted");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves idle, gate, and terminal runs untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-recon-skip-"));
    try {
      const store = makeStore(dir);
      const { project, phase } = makeProject(store, dir);

      const idle = store.createRun({ phaseId: phase.id, projectId: project.id });

      const inReview = store.createRun({
        phaseId: phase.id,
        projectId: project.id,
      });
      recordStageTransition(inReview, "in_review", new Date("2026-01-01T00:00:00Z"));
      store.updateRun(inReview);

      const failed = store.createRun({ phaseId: phase.id, projectId: project.id });
      recordStageTransition(failed, "developing", new Date("2026-01-01T00:00:00Z"));
      recordStageTransition(failed, "failed", new Date("2026-01-01T00:01:00Z"));
      store.updateRun(failed);

      const reconciled = store.reconcileInterruptedRuns(
        new Date("2026-01-01T00:02:00Z"),
      );
      assert.equal(reconciled.length, 0);
      assert.equal(store.getRun(idle.id)!.stage, "idle");
      assert.equal(store.getRun(inReview.id)!.stage, "in_review");
      assert.equal(store.getRun(failed.id)!.stage, "failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists the reconciliation and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-recon-idem-"));
    try {
      const dbPath = join(dir, "store.json");
      const store = new SlopStore(dbPath);
      const { project, phase } = makeProject(store, dir);
      const run = store.createRun({ phaseId: phase.id, projectId: project.id });
      recordStageTransition(run, "researching", new Date("2026-01-01T00:00:00Z"));
      store.updateRun(run);

      const first = store.reconcileInterruptedRuns(
        new Date("2026-01-01T00:01:00Z"),
      );
      assert.equal(first.length, 1);

      // Re-load from disk to prove persistence, then reconcile again — no-op.
      const reloaded = new SlopStore(dbPath);
      assert.equal(reloaded.getRun(run.id)!.stage, "interrupted");
      assert.equal(
        reloaded.reconcileInterruptedRuns(new Date("2026-01-01T00:02:00Z"))
          .length,
        0,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
