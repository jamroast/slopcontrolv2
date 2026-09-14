import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readRoadmap } from "@slopcontrol/artifacts";
import { SlopStore } from "./store.js";
import { resolveStartResearchPhase, splitPhase } from "./split-phase.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "slop-split-"));
  const store = new SlopStore(join(dir, "store.json"));
  const projectRoot = join(dir, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const project = store.createProject({ name: "p", rootPath: projectRoot });
  return { dir, store, project, projectRoot };
}

describe("splitPhase", () => {
  it("splits a phase into N draft phases with sequential dependsOn", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const original = store.createPhase({
        projectId: project.id,
        description: "Build the full billing webhook",
        rootPath: projectRoot,
        dependsOn: ["00-prior"],
      });
      const result = splitPhase({
        store,
        project,
        phaseId: original.id,
        parts: [
          { title: "A1+A2", description: "Zanzibar gate + chat tool" },
          { description: "MCP add-on" },
          { description: "b2b add-on" },
        ],
      });

      assert.equal(result.supersededPhaseId, original.id);
      assert.equal(result.phases.length, 3);

      const superseded = store.getPhase(original.id);
      assert.equal(superseded?.status, "superseded");

      const [p1, p2, p3] = result.phases.map((p) => store.getPhase(p.id));
      assert.equal(p1?.status, "draft");
      assert.equal(p2?.status, "draft");
      assert.equal(p3?.status, "draft");
      // First inherits the original's deps; each subsequent depends on the previous.
      assert.deepEqual(p1?.dependsOn, ["00-prior"]);
      assert.deepEqual(p2?.dependsOn, [p1!.id]);
      assert.deepEqual(p3?.dependsOn, [p2!.id]);
      // Explicit title is honored.
      assert.equal(p1?.title, "A1+A2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-points dependents of the original to the last sub-phase", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const original = store.createPhase({
        projectId: project.id,
        description: "Broad phase",
        rootPath: projectRoot,
      });
      const dependent = store.createPhase({
        projectId: project.id,
        description: "Depends on broad phase",
        rootPath: projectRoot,
        dependsOn: [original.id],
      });
      const result = splitPhase({
        store,
        project,
        phaseId: original.id,
        parts: [
          { description: "Part one" },
          { description: "Part two" },
        ],
      });
      const lastId = result.phases[result.phases.length - 1]!.id;
      const updated = store.getPhase(dependent.id);
      assert.deepEqual(updated?.dependsOn, [lastId]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("interrupts an active run on the original phase", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const original = store.createPhase({
        projectId: project.id,
        description: "Broad phase",
        rootPath: projectRoot,
      });
      const run = store.createRun({ phaseId: original.id, projectId: project.id });
      run.stage = "researching";
      store.updateRun(run);

      let interrupted: string | null = null;
      splitPhase({
        store,
        project,
        phaseId: original.id,
        parts: [
          { description: "Part one" },
          { description: "Part two" },
        ],
        interruptRun: (runId) => {
          interrupted = runId;
        },
      });

      assert.equal(interrupted, run.id);
      assert.equal(store.getRun(run.id)?.stage, "interrupted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supersedes gate runs (in_review/accepted) so they don't linger on the superseded phase", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const original = store.createPhase({
        projectId: project.id,
        description: "Broad phase",
        rootPath: projectRoot,
      });
      const inReview = store.createRun({
        phaseId: original.id,
        projectId: project.id,
      });
      inReview.stage = "in_review";
      store.updateRun(inReview);
      const accepted = store.createRun({
        phaseId: original.id,
        projectId: project.id,
      });
      accepted.stage = "accepted";
      store.updateRun(accepted);
      const complete = store.createRun({
        phaseId: original.id,
        projectId: project.id,
      });
      complete.stage = "complete";
      store.updateRun(complete);

      splitPhase({
        store,
        project,
        phaseId: original.id,
        parts: [{ description: "Part one" }, { description: "Part two" }],
      });

      assert.equal(store.getRun(inReview.id)?.stage, "interrupted");
      assert.equal(store.getRun(accepted.id)?.stage, "interrupted");
      // Terminal runs are left untouched
      assert.equal(store.getRun(complete.id)?.stage, "complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the roadmap with superseded original and draft sub-phases", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const original = store.createPhase({
        projectId: project.id,
        description: "Broad phase",
        rootPath: projectRoot,
      });
      splitPhase({
        store,
        project,
        phaseId: original.id,
        parts: [
          { description: "Part one" },
          { description: "Part two" },
        ],
      });
      const roadmap = readRoadmap(projectRoot);
      assert.match(roadmap, new RegExp(`\\| ${original.id} \\|.*\\| superseded \\|`));
      assert.match(roadmap, /\| draft \|/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing phase, single part, empty parts, and unsplittable statuses", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      assert.throws(
        () =>
          splitPhase({
            store,
            project,
            phaseId: "99-missing",
            parts: [{ description: "a" }, { description: "b" }],
          }),
        /Phase not found/,
      );

      const phase = store.createPhase({
        projectId: project.id,
        description: "Broad phase",
        rootPath: projectRoot,
      });
      assert.throws(
        () =>
          splitPhase({
            store,
            project,
            phaseId: phase.id,
            parts: [{ description: "only one" }],
          }),
        /at least 2 parts/,
      );
      assert.throws(
        () =>
          splitPhase({
            store,
            project,
            phaseId: phase.id,
            parts: [],
          }),
        /at least 2 parts/,
      );

      phase.status = "developing";
      store.updatePhase(phase);
      assert.throws(
        () =>
          splitPhase({
            store,
            project,
            phaseId: phase.id,
            parts: [{ description: "a" }, { description: "b" }],
          }),
        /Cannot split a phase in status "developing"/,
      );

      phase.status = "design_complete";
      store.updatePhase(phase);
      assert.throws(
        () =>
          splitPhase({
            store,
            project,
            phaseId: phase.id,
            parts: [{ description: "a" }, { description: "b" }],
          }),
        /Cannot split a phase in status "design_complete"/,
      );

      phase.status = "draft";
      phase.worktreePath = "/tmp/some-worktree";
      store.updatePhase(phase);
      assert.throws(
        () =>
          splitPhase({
            store,
            project,
            phaseId: phase.id,
            parts: [{ description: "a" }, { description: "b" }],
          }),
        /active worktree/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveStartResearchPhase", () => {
  it("reuses an existing draft phase instead of creating a duplicate", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const draft = store.createPhase({
        projectId: project.id,
        description: "Workstream 1 — schema invariants",
        rootPath: projectRoot,
        dependsOn: ["00-prior"],
      });
      const resolved = resolveStartResearchPhase({
        store,
        project,
        phaseId: draft.id,
        description: "ignored — should reuse the draft's description",
        dependsOn: ["should-be-ignored"],
      });
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(resolved.reused, true);
        assert.equal(resolved.phase.id, draft.id);
        assert.equal(resolved.description, "Workstream 1 — schema invariants");
        assert.deepEqual(resolved.phase.dependsOn, ["00-prior"]);
      }
      // No new phase was created
      assert.equal(store.listPhases(project.id).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a new phase when no phaseId is passed", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const resolved = resolveStartResearchPhase({
        store,
        project,
        description: "Workstream 1 — schema invariants",
        dependsOn: ["00-prior"],
      });
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(resolved.reused, false);
        assert.equal(resolved.description, "Workstream 1 — schema invariants");
        assert.deepEqual(resolved.phase.dependsOn, ["00-prior"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects superseded and non-draft phases", () => {
    const { dir, store, project, projectRoot } = setup();
    try {
      const superseded = store.createPhase({
        projectId: project.id,
        description: "split original",
        rootPath: projectRoot,
      });
      superseded.status = "superseded";
      store.updatePhase(superseded);
      const r1 = resolveStartResearchPhase({
        store,
        project,
        phaseId: superseded.id,
        description: "x",
      });
      assert.equal(r1.ok, false);
      if (!r1.ok) assert.equal(r1.status, 409);

      const inReview = store.createPhase({
        projectId: project.id,
        description: "already reviewed",
        rootPath: projectRoot,
      });
      inReview.status = "in_review";
      store.updatePhase(inReview);
      const r2 = resolveStartResearchPhase({
        store,
        project,
        phaseId: inReview.id,
        description: "x",
      });
      assert.equal(r2.ok, false);
      if (!r2.ok) assert.equal(r2.status, 409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
