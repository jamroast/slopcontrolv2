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

  it("persists the latest verdict split and fault-aware actions when research gaps are open", () => {
    // Verbatim gaps from the phase-30 identical-failure loop: the judge blamed
    // both legs, but operatorActions kept saying "research intact" — openclaw
    // followed that guidance into 9 draft-only retries that could never close
    // the research gap.
    const researchGap =
      "RESEARCH.md does not verify how the embedded iframe authority is configured (env var/prop) or that `AUTH_IDP_ISSUER`/`AUTH_IDP_ID` control the `AuthProvider`/`<SignIn>` iframe src; the fenced e2e depends on this unverified wiring.";
    const draftGap =
      "Automated Checks still includes a live Playwright run (`npx playwright test tests/e2e/embedded-signin.spec.ts`) as a runtime app proof against a booted app server (Playwright `webServer`), violating the Automated Checks rule 'app-runtime proofs use build/typecheck or a short Node one-shot'.";
    const d = buildPlanningFailureDiagnosis({
      stage: "draft",
      title: "Draft rejected: phase quality judge",
      detail: `${researchGap}; ${draftGap}`,
      phaseId: "30-iframe",
      runId: "run-1",
      kind: "draft-failed",
      faultLeg: "both",
      issues: [researchGap, draftGap],
      openIssues: [researchGap, draftGap],
      researchIssues: [researchGap],
      draftIssues: [draftGap],
      latestResearchIssues: [researchGap],
      latestDraftIssues: [draftGap],
    });
    assert.deepEqual(d.latestResearchIssues, [researchGap]);
    assert.deepEqual(d.latestDraftIssues, [draftGap]);
    assert.ok(
      d.operatorActions.some((a) => /re-runs the research leg/i.test(a)),
      "open research gaps must steer the operator to the research-leg retry",
    );
    assert.ok(
      !d.operatorActions.some((a) => /research intact/i.test(a)),
      "misleading 'research intact' wording must not appear while research gaps are open",
    );
    assert.match(d.nextActions, /research leg/i);
  });

  it("keeps draft-only guidance when no research gaps are open", () => {
    const d = buildPlanningFailureDiagnosis({
      stage: "draft",
      title: "Draft rejected: phase quality judge",
      detail: "Check 7 uses bare npm test without a path",
      phaseId: "01-x",
      runId: "run-1",
      kind: "draft-failed",
      faultLeg: "draft",
      issues: ["Check 7 uses bare npm test without a path"],
      draftIssues: ["Check 7 uses bare npm test without a path"],
      latestDraftIssues: ["Check 7 uses bare npm test without a path"],
    });
    assert.ok(
      d.operatorActions.some((a) => /research intact/i.test(a)),
      "draft-only guidance stays when the fault is draft-attributed",
    );
    assert.match(d.nextActions, /research intact/i);
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
