import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildPlanningFailureDiagnosis,
  isPlannerRefusalOutput,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  researchLooksSolid,
  writeDiagnosis,
} from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("planning failure diagnosis", () => {
  it("buildPlanningFailureDiagnosis marks process/coding for draft Change Intent rejects", () => {
    const d = buildPlanningFailureDiagnosis({
      stage: "draft",
      title: "Draft rejected: Change Intent",
      detail:
        "Engagement Change Intent requires Automated Checks / Success Criteria that prove live AI SDK static tool-part name resolution",
      phaseId: "12-phase",
      runId: "run-1",
      kind: "change-intent",
    });
    assert.equal(d.class, "process");
    assert.equal(d.audience, "coding");
    assert.equal(d.codingAgentShouldFix, true);
    assert.match(d.fingerprint, /planning-change-intent/);
    assert.match(d.nextActions, /Retry draft/i);
    assert.ok(d.operatorActions.length > 0);
    assert.match(d.operatorActions.join(" "), /parseToolResult|tool-</i);
    assert.match(d.operatorActions.join(" "), /retry_draft/i);
  });

  it("researchLooksSolid accepts RESEARCH_COMPLETE documents", () => {
    const body = `# Research\n\n${"x".repeat(400)}\n\nRESEARCH_COMPLETE`;
    assert.equal(researchLooksSolid(body), true);
    assert.equal(researchLooksSolid("short"), false);
  });

  it("isPlannerRefusalOutput detects chat refusals without phase structure", () => {
    assert.equal(
      isPlannerRefusalOutput(
        "I don't have a phase specification — the request came through empty.",
      ),
      true,
    );
    assert.equal(
      isPlannerRefusalOutput("Please provide the phase description."),
      true,
    );
    const valid = `# Phase 96: unify connection\n\n## Scope\n\nWork.\n\n## Automated Checks\n\n\`\`\`bash\nnpm test\n\`\`\``;
    assert.equal(isPlannerRefusalOutput(valid), false);
    assert.equal(isPlannerRefusalOutput(""), false);
  });

  it("writeDiagnosis persists run + phase diagnosis for planning failures", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-plan-diag-"));
    roots.push(root);
    const diagnosis = buildPlanningFailureDiagnosis({
      stage: "draft",
      title: "Draft rejected: Change Intent",
      detail: "missing live static tool-part proof",
      phaseId: "12-chat",
      runId: "a0d93c12-test",
      kind: "change-intent",
    });
    writeDiagnosis(root, "a0d93c12-test", diagnosis, "12-chat");
    const fromRun = readDiagnosis(root, "a0d93c12-test");
    assert.ok(fromRun);
    assert.equal(fromRun!.title, "Draft rejected: Change Intent");
    assert.equal(fromRun!.phaseId, "12-chat");
    const fromPhase = readLatestDiagnosisForPhase(root, "12-chat");
    assert.ok(fromPhase);
    assert.equal(fromPhase!.fingerprint, fromRun!.fingerprint);
    const raw = JSON.parse(
      readFileSync(
        join(root, ".slopcontrol", "runs", "a0d93c12-test", "diagnosis.json"),
        "utf-8",
      ),
    ) as { class: string };
    assert.equal(raw.class, "process");
  });

});
