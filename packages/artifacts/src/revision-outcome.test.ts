import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildPlanningRevisionFailureDiagnosis,
  buildReviewApprovalFailureDiagnosis,
  buildRevisionArtifactOutcome,
  composeReviewRevisionFeedback,
  readRevisionOutcome,
  summarizeRevisionOutcome,
  writeRevisionOutcome,
} from "./revision-outcome.js";

describe("revision outcome", () => {
  it("round-trips write/read", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-revision-"));
    try {
      const outcome = writeRevisionOutcome(root, "run-1", {
        targets: "both",
        ok: true,
        updatedAt: new Date().toISOString(),
        research: {
          artifact: "research",
          attempted: true,
          harvested: true,
          changed: true,
          ok: true,
          reason: "applied",
        },
        phase: {
          artifact: "phase",
          attempted: true,
          harvested: true,
          changed: true,
          ok: true,
          reason: "applied",
        },
      });
      const read = readRevisionOutcome(root, "run-1");
      assert.deepEqual(read, outcome);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("summarizes failed research harvest", () => {
    const text = summarizeRevisionOutcome({
      targets: "both",
      ok: false,
      updatedAt: new Date().toISOString(),
      research: {
        artifact: "research",
        attempted: true,
        harvested: false,
        ok: false,
        reason: "harvest failed",
      },
      phase: {
        artifact: "phase",
        attempted: false,
        ok: true,
        reason: "not targeted",
      },
    });
    assert.match(text, /research=failed/);
    assert.match(text, /ok=false/);
  });

  it("buildPlanningRevisionFailureDiagnosis tags review-revision", () => {
    const d = buildPlanningRevisionFailureDiagnosis({
      feedback: "use getIssuerConfig",
      phaseId: "p1",
      runId: "r1",
      outcome: {
        targets: "research",
        ok: false,
        updatedAt: new Date().toISOString(),
        research: buildRevisionArtifactOutcome({
          artifact: "research",
          attempted: true,
          harvested: false,
          failReason: "harvest failed",
        }),
      },
    });
    assert.equal(d.audience, "operator");
    assert.ok(d.tags?.includes("review-revision"));
    assert.equal(d.codingAgentShouldFix, false);
  });

  it("buildReviewApprovalFailureDiagnosis forbids retry_draft at in_review", () => {
    const d = buildReviewApprovalFailureDiagnosis({
      reason: "PHASE.md failed validation: long-lived server",
      phaseId: "p1",
      runId: "r1",
    });
    assert.ok(d.tags?.includes("review-approval-blocked"));
    assert.match(d.operatorActions.join(" "), /request_changes/i);
    assert.match(d.operatorActions.join(" "), /Do NOT call retry_draft/i);
  });

  it("composeReviewRevisionFeedback merges operator hint and validation issues", () => {
    const text = composeReviewRevisionFeedback({
      operatorHint: "fix automated checks",
      phaseValidationIssues: [
        "Broken Automated Check starts a long-lived server (docker compose up)",
      ],
    });
    assert.match(text, /fix automated checks/i);
    assert.match(text, /long-lived server/i);
    assert.match(text, /Automated Checks/i);
  });
});

describe("revision feedback unfulfillable", () => {
  function verdictOutcome(unfulfillable: string[]) {
    return {
      targets: "phase" as const,
      ok: false,
      updatedAt: new Date().toISOString(),
      phase: buildRevisionArtifactOutcome({
        artifact: "phase",
        attempted: true,
        harvested: true,
        verdict: {
          ok: false,
          changed: false,
          reason: "feedback requires the development stage",
          missing: [],
          unfulfillable,
        },
      }),
    };
  }

  it("outcome rows carry unfulfillable bullets", () => {
    const o = buildRevisionArtifactOutcome({
      artifact: "phase",
      attempted: true,
      harvested: true,
      verdict: {
        ok: false,
        changed: false,
        reason: "feedback requires the development stage",
        missing: [],
        unfulfillable: ["CREATE src/lib/x.test.ts on disk"],
      },
    });
    assert.deepEqual(o.unfulfillable, ["CREATE src/lib/x.test.ts on disk"]);
  });

  it("diagnosis routes the operator to approve→develop instead of resubmission", () => {
    const d = buildPlanningRevisionFailureDiagnosis({
      feedback: "write the code",
      phaseId: "p202",
      runId: "r1",
      outcome: verdictOutcome(["CREATE src/lib/x.test.ts on disk"]),
    });
    assert.ok(d.tags?.includes("revision-feedback-unfulfillable"));
    const actions = d.operatorActions ?? [];
    assert.ok(
      actions.some((a) =>/submit_review\(approve\)/.test(a) && /start_development/.test(a)),
      `expected approve→develop routing, got: ${actions.join(" | ")}`,
    );
    assert.ok(
      actions.some((a) => /Do NOT resubmit the same code-write feedback/.test(a)),
    );
    assert.match(d.nextActions ?? "", /submit_review\(approve\)/);
    assert.match(d.nextActions ?? "", /start_development/);
  });
});
