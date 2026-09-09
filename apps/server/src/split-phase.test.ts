import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readRoadmap } from "@slopcontrol/artifacts";
import { SlopStore } from "./store.js";
import { splitPhase } from "./split-phase.js";

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
