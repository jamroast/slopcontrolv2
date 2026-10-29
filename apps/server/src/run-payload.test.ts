import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Phase, Project, Run } from "@slopcontrol/types";
import { buildRunPayload, type RunPayloadStore } from "./run-payload.js";

function makeFixture(stage: string) {
  const root = mkdtempSync(join(tmpdir(), "slop-run-payload-"));
  const projectId = "proj-1";
  const phaseId = "phase-1";
  const runId = "run-1";

  const runDir = join(root, ".slopcontrol", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "log.txt"),
    Array.from({ length: 800 }, (_, i) => `log line ${i}`).join("\n") + "\n",
  );
  writeFileSync(
    join(runDir, "diagnosis.json"),
    JSON.stringify({
      audience: "operator",
      operatorActions: ["review it"],
      class: "planning",
      confidence: "high",
      title: "Judge rejected draft",
      rootCause: "missing check target",
      evidence: "evidence",
      nextActions: "next",
      fingerprint: "fp",
      codingAgentShouldFix: false,
    }),
  );
  const phaseDir = join(root, ".slopcontrol", "phases", phaseId);
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "RESEARCH.md"), "# Research\n\nFindings here.\n");
  writeFileSync(
    join(phaseDir, "PHASE.md"),
    "# Phase 1 — demo\n\n## Scope\n\nx\n",
  );

  const project = { id: projectId, rootPath: root } as Project;
  const phase = {
    id: phaseId,
    projectId,
    description: "demo phase",
    status: "in_review",
    dependsOn: [],
  } as unknown as Phase;
  const run = {
    id: runId,
    projectId,
    phaseId,
    stage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    iterationCount: 2,
    stageTimings: [],
  } as unknown as Run;

  const store: RunPayloadStore = {
    getProject: (id: string) => (id === projectId ? project : undefined),
    getPhase: (id: string) => (id === phaseId ? phase : undefined),
    listPhases: () => [phase],
  };
  return { store, run };
}

const HEAVY_KEYS = [
  "research_output",
  "research_conclusion",
  "dev_output",
  "phase_doc",
  "verify_steps",
  "phase_validation_issues",
  "suggested_revision_feedback",
] as const;

describe("buildRunPayload", () => {
  it("list mode omits heavy fields and keeps triage fields", () => {
    const { store, run } = makeFixture("in_review");
    const payload = buildRunPayload(
      { store, activeRuns: new Set() },
      run,
      { includeHeavy: false },
    );
    assert.ok(payload, "payload");
    for (const key of HEAVY_KEYS) {
      assert.ok(!(key in payload!), `${key} must be omitted in list mode`);
    }
    const slim = payload as Record<string, unknown>;
    assert.equal(slim.id, "run-1");
    assert.equal(slim.phase_id, "phase-1");
    assert.equal(slim.idea, "demo phase");
    assert.match(String(slim.failure_summary ?? ""), /Judge rejected draft/);
    assert.equal(
      (slim.operator_suggestions as { title?: string } | null)?.title,
      "Judge rejected draft",
    );
    assert.equal(slim.researchRunning, false);
  });

  it("detail mode includes heavy fields with content", () => {
    const { store, run } = makeFixture("in_review");
    const payload = buildRunPayload({ store, activeRuns: new Set() }, run);
    assert.ok(payload, "payload");
    assert.match(
      (payload as Record<string, unknown>).research_output as string,
      /Findings here/,
    );
    assert.match(
      (payload as Record<string, unknown>).phase_doc as string,
      /# Phase 1/,
    );
    // 800-line log → 500-line tail
    const devOutput = (payload as Record<string, unknown>)
      .dev_output as string;
    assert.match(devOutput, /log line 799/);
    assert.ok(!devOutput.includes("log line 100\n"));
    assert.ok("verify_steps" in payload);
    assert.ok("suggested_revision_feedback" in payload);
  });

  it("default mode is detail (backwards compatible)", () => {
    const { store, run } = makeFixture("developing");
    const payload = buildRunPayload({ store, activeRuns: new Set() }, run);
    assert.ok("dev_output" in payload!);
    assert.ok("phase_doc" in payload!);
  });
});
