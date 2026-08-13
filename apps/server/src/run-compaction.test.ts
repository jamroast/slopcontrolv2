import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Run } from "@slopcontrol/types";
import {
  compactProjectRuns,
  compactRuns,
  planCompaction,
  type ExecFn,
} from "./run-compaction.js";
import { evaluateProjectCompaction } from "./run-compaction-watcher.js";
import { SlopStore } from "./store.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-compact-${name}-`));
}

function makeRun(over: Partial<Run> & { id: string }): Run {
  const now = new Date().toISOString();
  return {
    phaseId: "01-p",
    projectId: "proj",
    stage: "complete",
    iterationCount: 1,
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    stageTimings: [],
    ...over,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1_000).toISOString();
}

describe("planCompaction", () => {
  it("returns no merge set when terminal count is under maxRuns", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun({ id: `r${i}`, createdAt: daysAgo(30 - i) }),
    );
    const plan = planCompaction({
      runs,
      activeRunIds: new Set(),
      config: { maxRuns: 10, keepLatest: 3, minAgeDays: 0 },
    });
    assert.equal(plan.mergeSet.length, 0);
    assert.match(plan.reason ?? "", /maxRuns/);
  });

  it("selects oldest terminal runs, keeping keepLatest", () => {
    const runs = Array.from({ length: 8 }, (_, i) =>
      makeRun({
        id: `r${i}`,
        phaseId: `ph-${i}`,
        createdAt: daysAgo(40 - i),
      }),
    );
    const plan = planCompaction({
      runs,
      activeRunIds: new Set(),
      config: { maxRuns: 5, keepLatest: 3, minAgeDays: 0 },
    });
    // 8 terminal > 5 → merge oldest (8 - 3) = 5, minus latest-per-phase
    // exclusions: each run is its own phase's latest, so nothing is eligible.
    assert.equal(plan.mergeSet.length, 0);
  });

  it("never compacts the latest run per phase, active runs, or young runs", () => {
    const runs = [
      // phase-a: two old runs — older one eligible
      makeRun({ id: "a1", phaseId: "phase-a", createdAt: daysAgo(40) }),
      makeRun({ id: "a2", phaseId: "phase-a", createdAt: daysAgo(30) }),
      // phase-b: two old runs — older one eligible
      makeRun({ id: "b1", phaseId: "phase-b", createdAt: daysAgo(39) }),
      makeRun({ id: "b2", phaseId: "phase-b", createdAt: daysAgo(29) }),
      // phase-c: older one is active — protected
      makeRun({ id: "c1", phaseId: "phase-c", createdAt: daysAgo(38) }),
      makeRun({ id: "c2", phaseId: "phase-c", createdAt: daysAgo(28) }),
      // phase-d: older one too young
      makeRun({ id: "d1", phaseId: "phase-d", createdAt: daysAgo(2) }),
      makeRun({ id: "d2", phaseId: "phase-d", createdAt: daysAgo(1) }),
    ];
    const plan = planCompaction({
      runs,
      activeRunIds: new Set(["c1"]),
      config: { maxRuns: 4, keepLatest: 2, minAgeDays: 7 },
    });
    const ids = plan.mergeSet.map((r) => r.id);
    assert.ok(ids.includes("a1"), "oldest eligible merged");
    assert.ok(ids.includes("b1"), "second-oldest eligible merged");
    assert.ok(!ids.includes("a2"), "latest-per-phase protected");
    assert.ok(!ids.includes("c1"), "active run protected");
    assert.ok(!ids.includes("d1"), "young run protected");
    // keepLatest=2 → merge count = 8 - 2 = 6, capped by eligibility (2)
    assert.equal(ids.length, 2);
  });

  it("skips already-archived rows", () => {
    const runs = [
      makeRun({ id: "a1", phaseId: "phase-a", createdAt: daysAgo(40) }),
      makeRun({ id: "a2", phaseId: "phase-a", createdAt: daysAgo(30) }),
      makeRun({
        id: "archive-1",
        phaseId: "phase-a",
        createdAt: daysAgo(50),
        archived: true,
        mergedRunIds: ["x"],
      }),
    ];
    const plan = planCompaction({
      runs,
      activeRunIds: new Set(),
      config: { maxRuns: 1, keepLatest: 1, minAgeDays: 0 },
    });
    assert.ok(!plan.mergeSet.some((r) => r.id === "archive-1"));
  });
});

function seedRunDir(root: string, runId: string): void {
  const dir = join(root, ".slopcontrol", "runs", runId);
  mkdirSync(join(dir, "checks"), { recursive: true });
  writeFileSync(join(dir, "log.txt"), "line1\nline2\n", "utf-8");
  writeFileSync(
    join(dir, "memory.json"),
    JSON.stringify([
      {
        iteration: 1,
        status: "ok",
        errorCount: 0,
        errorHash: "h",
        noProgressStreak: 0,
        timestamp: new Date().toISOString(),
        details: "d",
        nextActionsSummary: "ship it",
      },
    ]),
    "utf-8",
  );
}

const fakeExec: ExecFn = async (cmd, args) => {
  if (cmd === "git") return { code: 1, stdout: "", stderr: "no repo" };
  if (cmd === "tar") {
    // Emulate tar: write the archive file (last -f argument).
    const fIdx = args.indexOf("-czf");
    writeFileSync(args[fIdx + 1]!, "fake-tgz", "utf-8");
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

describe("compactRuns", () => {
  it("archives digests, swaps store rows, deletes originals", async () => {
    const root = tmp("run");
    const dataDir = tmp("store");
    try {
      const store = new SlopStore(join(dataDir, "store.json"));
      const runs = ["p1", "p1", "p2"].map((phaseId, i) => {
        const run = store.createRun({ phaseId, projectId: "proj" });
        run.createdAt = daysAgo(40 - i);
        run.iterationCount = 1;
        store.updateRun(run);
        return run;
      });
      for (const run of runs) seedRunDir(root, run.id);

      const result = await compactRuns({
        projectId: "proj",
        projectRoot: root,
        store,
        runs,
        exec: fakeExec,
        now: new Date("2026-08-12T20:00:00.000Z"),
      });

      assert.equal(result.ok, true);
      assert.equal(result.archiveRunId, "archive-20260812-200000");
      const mergedIds = runs.map((r) => r.id);
      assert.deepEqual(result.manifest.mergedRunIds, mergedIds);
      assert.equal(result.manifest.digests.length, 3);
      assert.equal(result.manifest.digests[0]?.memoryIterations, 1);
      assert.equal(result.manifest.digests[0]?.lastNextActions, "ship it");
      assert.deepEqual(result.manifest.digests[0]?.logTail.slice(-2), [
        "line2",
        "",
      ]);
      assert.equal(result.manifest.unifiedChanges, null); // no git repo
      assert.ok(existsSync(join(result.archiveDir, "raw.tar.gz")));
      assert.ok(existsSync(join(result.archiveDir, "ARCHIVE.json")));

      // Store swap: tombstones + synthetic archive row.
      const tomb = store.getRun(runs[0]!.id);
      assert.equal(tomb?.archived, true);
      assert.equal(tomb?.archivedInto, result.archiveRunId);
      const archive = store.getRun(result.archiveRunId);
      assert.equal(archive?.archived, true);
      assert.deepEqual(archive?.mergedRunIds, mergedIds);
      assert.match(archive?.archiveTitle ?? "", /Archive: 3 runs/);
      assert.equal(archive?.iterationCount, 3);

      // Originals deleted.
      for (const run of runs) {
        assert.equal(
          existsSync(join(root, ".slopcontrol", "runs", run.id)),
          false,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resolves a unified diff when merge commits exist", async () => {
    const root = tmp("git");
    const dataDir = tmp("store2");
    try {
      const store = new SlopStore(join(dataDir, "store.json"));
      const runs = ["p1", "p1"].map((phaseId, i) => {
        const run = store.createRun({ phaseId, projectId: "proj" });
        run.createdAt = daysAgo(40 - i);
        store.updateRun(run);
        return run;
      });
      for (const run of runs) seedRunDir(root, run.id);
      const exec: ExecFn = async (cmd, args) => {
        if (cmd === "git" && args[0] === "log") {
          return { code: 0, stdout: "abc123\n", stderr: "" };
        }
        if (cmd === "git" && args[0] === "diff") {
          return { code: 0, stdout: " src/a.ts | 2 +-\n 1 file changed", stderr: "" };
        }
        return fakeExec(cmd, args, "");
      };
      const result = await compactRuns({
        projectId: "proj",
        projectRoot: root,
        store,
        runs,
        exec,
      });
      assert.match(result.manifest.unifiedChanges?.stat ?? "", /1 file changed/);
      assert.equal(result.manifest.unifiedChanges?.fromRef, "abc123^");
      assert.equal(result.manifest.unifiedChanges?.toRef, "abc123");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("compactProjectRuns (endpoint decision)", () => {
  it("409s when a run is active", async () => {
    const dataDir = tmp("ep-busy");
    const root = tmp("ep-busy-root");
    try {
      const store = new SlopStore(join(dataDir, "store.json"));
      const run = store.createRun({ phaseId: "p1", projectId: "proj" });
      const result = await compactProjectRuns({
        projectId: "proj",
        projectRoot: root,
        store,
        activeRunIds: new Set([run.id]),
      });
      assert.equal(result.status, 409);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dryRun returns the merge set without writing anything", async () => {
    const dataDir = tmp("ep-dry");
    const root = tmp("ep-dry-root");
    try {
      const store = new SlopStore(join(dataDir, "store.json"));
      // 3 phases × 2 runs, all old → 3 eligible (latest-per-phase protected)
      for (const phaseId of ["p1", "p2", "p3"]) {
        for (const age of [40, 30]) {
          const run = store.createRun({ phaseId, projectId: "proj" });
          run.stage = "complete";
          run.createdAt = daysAgo(age);
          store.updateRun(run);
          seedRunDir(root, run.id);
        }
      }
      const result = await compactProjectRuns({
        projectId: "proj",
        projectRoot: root,
        store,
        activeRunIds: new Set(),
        dryRun: true,
        config: { maxRuns: 3, keepLatest: 3, minAgeDays: 7 },
      });
      assert.equal(result.status, 200);
      if (result.status !== 200) throw new Error("unreachable");
      assert.equal(result.body.dryRun, true);
      assert.equal((result.body.mergeSet as unknown[]).length, 3);
      // Nothing written: store rows intact, no archive dir.
      assert.equal(store.listRuns("proj").length, 6);
      assert.equal(existsSync(join(root, ".slopcontrol", "archive")), false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluateProjectCompaction", () => {
  it("skips busy projects and under-threshold projects", () => {
    const dataDir = tmp("watch");
    const root = tmp("watch-root");
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      const store = new SlopStore(join(dataDir, "store.json"));
      store.createProject({
        name: "p",
        rootPath: root,
      });
      const project = store.listProjects()[0]!;
      const busy = evaluateProjectCompaction(
        {
          store,
          isRunActive: () => false,
          projectBusy: () => true,
        },
        project.id,
        root,
      );
      assert.equal(busy, null, "busy project skipped");

      const quiet = evaluateProjectCompaction(
        {
          store,
          isRunActive: () => false,
          projectBusy: () => false,
        },
        project.id,
        root,
      );
      assert.equal(quiet, null, "no runs → nothing to compact");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
