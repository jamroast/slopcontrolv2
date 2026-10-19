import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPlanningFailureDiagnosis } from "@slopcontrol/artifacts";
import {
  formatPriorDraftFeedbackBlock,
  PRIOR_DRAFT_FEEDBACK_TITLE,
  MAX_PLANNING_SELF_HEAL_ROUNDS,
  planningGateIssueFingerprint,
  priorDraftJudgeIssuesFromDiagnosis,
  shouldContinuePlanningSelfHeal,
} from "./planning-pipeline.js";
import {
  clipPromptSection,
  clipSharedDoc,
  JUDGE_DOC_EXCERPT_MAX_CHARS,
  SLIM_RESEARCH_CLIP_CHARS,
} from "./prompt-clip.js";

/**
 * Harness for the planning feedback loop: does a judge rejection actually reach
 * the next draft? Phase 196 burned four review rounds because retry_draft
 * re-drafted blind (diagnosis deleted, gaps never passed). These tests pin the
 * whole chain: persist diagnosis → extract gaps → render the draft block.
 */

const GAPS = [
  "Automated Check 13 greps `mcp:read` in `src/lib/service-token/routes.ts`, but that file validates requested ⊆ allowedScopes and contains no literal `mcp:read` — the check fails for the wrong reason.",
  "Automated Check 12 scans all of src for `entry.access` and does not exclude `src/lib/mcp/registry-access.meta.test.ts`, which N14.3 requires to read it.",
  "## File Changes is a placeholder ('TBD during development'); RESEARCH §12 names the exact files.",
];

function draftRejectionDiagnosis(gaps: string[] = GAPS) {
  return buildPlanningFailureDiagnosis({
    stage: "draft",
    title: "Draft rejected: phase quality judge",
    detail: gaps.join("; "),
    phaseId: "196-x",
    runId: "run-1",
    kind: "phase-quality",
    faultLeg: "draft",
    issues: gaps,
  });
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("planning feedback harness: judge gaps reach the next draft", () => {
  it("round-trips every gap from the persisted diagnosis into the draft block", () => {
    const issues = priorDraftJudgeIssuesFromDiagnosis(draftRejectionDiagnosis());
    assert.deepEqual(issues, GAPS);

    // This is exactly the block draftPhase injects into the re-draft prompt.
    const block = formatPriorDraftFeedbackBlock(issues);
    assert.ok(block.startsWith(PRIOR_DRAFT_FEEDBACK_TITLE));
    assert.match(block, new RegExp(escapeRe(PRIOR_DRAFT_FEEDBACK_TITLE)));
    for (const gap of GAPS) {
      assert.ok(block.includes(gap), `draft block missing gap: ${gap.slice(0, 60)}`);
    }
  });

  it("keeps a multi-gap list intact (diagnosis evidence budget)", () => {
    // Phase-196-class rejections are several hundred chars per gap. A 4k
    // evidence cap would slice the last one mid-sentence and feed the draft a
    // truncated requirement.
    const many = Array.from(
      { length: 6 },
      (_, i) => `Check ${i + 1}: ${"detail ".repeat(80)}end-of-gap-${i}`,
    );
    const issues = priorDraftJudgeIssuesFromDiagnosis(
      draftRejectionDiagnosis(many),
    );
    assert.equal(issues.length, 6);
    assert.ok(issues[5]?.includes("end-of-gap-5"));
  });

  it("falls back to evidence splitting for legacy diagnoses without issues[]", () => {
    assert.deepEqual(
      priorDraftJudgeIssuesFromDiagnosis({
        title: "Draft rejected: phase quality judge",
        rootCause: "gap one",
        evidence: "gap one; gap two",
        tags: ["planning", "draft", "phase-quality"],
      }),
      ["gap one", "gap two"],
    );
  });

  it("ignores non-draft diagnoses (verify/research are not draft feedback)", () => {
    assert.deepEqual(
      priorDraftJudgeIssuesFromDiagnosis({
        title: "Verify failed",
        rootCause: "testCommand exited 1",
        evidence: "testCommand exited 1",
        tags: ["verify", "product"],
      }),
      [],
    );
    assert.deepEqual(
      priorDraftJudgeIssuesFromDiagnosis(
        buildPlanningFailureDiagnosis({
          stage: "research",
          title: "Research failed: quality judge",
          detail: "missing evidence",
          phaseId: "196-x",
          runId: "run-1",
          kind: "research-quality",
        }),
      ),
      [],
    );
    assert.deepEqual(priorDraftJudgeIssuesFromDiagnosis(null), []);
    assert.equal(formatPriorDraftFeedbackBlock([]), "");
  });

  it("self-heal carries gaps across rounds and stops at the bound", () => {
    const fp = planningGateIssueFingerprint(GAPS);
    assert.equal(planningGateIssueFingerprint([...GAPS].reverse()), fp);
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        round: 0,
        maxRounds: MAX_PLANNING_SELF_HEAL_ROUNDS,
      }),
      true,
    );
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        round: MAX_PLANNING_SELF_HEAL_ROUNDS - 1,
        maxRounds: MAX_PLANNING_SELF_HEAL_ROUNDS,
      }),
      false,
    );
  });
});

describe("planning prompt windows: drafter and judge see the same research", () => {
  const HEAD = "HEAD_SECTION_TOKEN";
  const MIDDLE = "MIDDLE_SECTION_TOKEN";
  const TAIL = "TAIL_SECTION_TOKEN";
  const docPath = ".slopcontrol/phases/196-x/RESEARCH.md";
  // 120k chars: beyond the shared 96k window, so both ends must survive.
  const research = `${HEAD}\n${"h".repeat(60_000)}${MIDDLE}${"m".repeat(60_000)}${TAIL}`;

  it("gives the drafter and the judge byte-identical windows", () => {
    const drafter = clipSharedDoc("RESEARCH.md", research, docPath);
    const judge = clipSharedDoc("RESEARCH.md", research, docPath);
    assert.equal(drafter, judge);
    assert.ok(drafter.includes(HEAD), "head section lost");
    assert.ok(drafter.includes(TAIL), "tail section lost (N-criteria live here)");
    assert.ok(!drafter.includes(MIDDLE), "middle should be clipped past the budget");
    assert.ok(
      drafter.includes(`read_file \`${docPath}\``),
      "truncation hint must name the real phase-relative path",
    );
    assert.ok(drafter.length <= JUDGE_DOC_EXCERPT_MAX_CHARS + 32);
  });

  it("slim draft retry shrinks research but keeps both ends", () => {
    const slim = clipPromptSection(
      "RESEARCH.md",
      research,
      SLIM_RESEARCH_CLIP_CHARS,
      docPath,
      true,
    );
    assert.ok(slim.includes(HEAD));
    assert.ok(slim.includes(TAIL));
    assert.ok(!slim.includes(MIDDLE));
    assert.ok(slim.length <= SLIM_RESEARCH_CLIP_CHARS + 32);
    assert.ok(slim.length < clipSharedDoc("RESEARCH.md", research, docPath).length);
  });

  it("passes small docs through and labels empty ones", () => {
    assert.equal(clipSharedDoc("RESEARCH.md", "short doc", docPath), "short doc");
    assert.equal(clipSharedDoc("RESEARCH.md", "   ", docPath), "(RESEARCH.md: none)");
  });
});
