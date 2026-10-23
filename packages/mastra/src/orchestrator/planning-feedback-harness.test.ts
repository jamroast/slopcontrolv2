import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildPlanningFailureDiagnosis,
  consolidateText,
  readDiagnosis,
  writeDiagnosis,
} from "@slopcontrol/artifacts";
import {
  formatPriorDraftFeedbackBlock,
  PRIOR_DRAFT_FEEDBACK_TITLE,
  MAX_PLANNING_SELF_HEAL_ROUNDS,
  nextSelfHealDraftIssues,
  planningGateIssueFingerprint,
  priorDraftJudgeIssuesFromDiagnosis,
  shouldContinuePlanningSelfHeal,
} from "./planning-pipeline.js";
import { planningGateFeedbackFromLatestDiagnosis } from "./index.js";
import {
  clipDraftResearch,
  clipSharedDoc,
  JUDGE_DOC_EXCERPT_MAX_CHARS,
  SLIM_RESEARCH_CLIP_CHARS,
} from "./prompt-clip.js";

/**
 * Harness for the planning feedback loop: a judge rejection must reach the
 * next draft. These tests pin persist → read → extract → draft block, including
 * a gap that itself contains "; ", and the drafter/judge research windows.
 */

/** First gap contains "; ", which a flat join cannot round-trip. */
const GAPS = [
  "Automated Check 3 greps `token:read` in `src/lib/access/routes.ts`, but that file checks requested ⊆ allowed and contains no literal `token:read`; the check fails for the wrong reason.",
  "Automated Check 2 scans src for `entry.access` and does not exclude `src/lib/access/registry.test.ts`, which the research note requires to read it.",
  "## File Changes is a placeholder ('TBD during development'); RESEARCH names the exact files.",
];

function draftRejectionDiagnosis(gaps: string[] = GAPS) {
  return buildPlanningFailureDiagnosis({
    stage: "draft",
    title: "Draft rejected: phase quality judge",
    detail: gaps.join("; "),
    phaseId: "01-access",
    runId: "run-1",
    kind: "phase-quality",
    faultLeg: "draft",
    issues: gaps,
  });
}

describe("planning feedback harness: judge gaps reach the next draft", () => {
  it("round-trips a semicolon gap through disk into the draft block", () => {
    const root = mkdtempSync(join(tmpdir(), "planning-feedback-"));
    try {
      const diagnosis = draftRejectionDiagnosis();
      writeDiagnosis(root, "run-1", diagnosis, "01-access");
      const stored = readDiagnosis(root, "run-1");
      const issues = priorDraftJudgeIssuesFromDiagnosis(stored);
      assert.deepEqual(issues, GAPS);

      const block = formatPriorDraftFeedbackBlock(issues);
      assert.ok(block.startsWith(PRIOR_DRAFT_FEEDBACK_TITLE));
      for (const gap of GAPS) {
        assert.ok(block.includes(gap), `draft block missing gap: ${gap.slice(0, 60)}`);
      }
      // Standing guidance: the drafter must re-scope ungrounded tokens rather
      // than re-assert them (the phase-29 retry loop shape).
      assert.match(block, /fix the cause, not the wording/);
      assert.match(block, /never re-assert the flagged token unchanged/);
      assert.equal(issues.length, GAPS.length);
      assert.ok(issues[0]?.includes("wrong reason"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("splits a legacy diagnosis on the same semicolon the structured array keeps", () => {
    const legacy = priorDraftJudgeIssuesFromDiagnosis({
      title: "Draft rejected: phase quality judge",
      evidence: GAPS.join("; "),
      tags: ["planning", "draft", "phase-quality"],
    });
    assert.ok(legacy.length > GAPS.length);
    assert.ok(!legacy.includes(GAPS[0]!));
  });

  it("keeps gaps the 4k rootCause cap would slice", () => {
    const many = Array.from(
      { length: 8 },
      (_, i) => `Check ${i + 1}: ${"detail ".repeat(100)}end-of-gap-${i}`,
    );
    const joined = many.join("; ");
    assert.ok(joined.length > 4_000);
    const diagnosis = draftRejectionDiagnosis(many);
    assert.equal(diagnosis.rootCause.length, 4_000);
    assert.ok(!diagnosis.rootCause.includes("end-of-gap-7"));

    const root = mkdtempSync(join(tmpdir(), "planning-feedback-budget-"));
    try {
      writeDiagnosis(root, "run-1", diagnosis, "01-access");
      const issues = priorDraftJudgeIssuesFromDiagnosis(
        readDiagnosis(root, "run-1"),
      );
      assert.equal(issues.length, 8);
      assert.ok(issues[7]?.endsWith("end-of-gap-7"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
          phaseId: "01-access",
          runId: "run-1",
          kind: "research-quality",
        }),
      ),
      [],
    );
    assert.deepEqual(priorDraftJudgeIssuesFromDiagnosis(null), []);
    assert.equal(formatPriorDraftFeedbackBlock([]), "");
  });

  it("self-heal carries structured gaps into the next draft and stops at the bound", () => {
    const carried = nextSelfHealDraftIssues(GAPS.join("; "), GAPS);
    assert.deepEqual(carried, GAPS);
    const block = formatPriorDraftFeedbackBlock(carried);
    assert.ok(block.includes(GAPS[0]!));

    const split = nextSelfHealDraftIssues(GAPS.join("; "));
    assert.ok(split.length > carried.length);

    assert.equal(planningGateIssueFingerprint(carried), planningGateIssueFingerprint([...carried].reverse()));
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
  const docPath = ".slopcontrol/phases/01-access/RESEARCH.md";
  // 120k chars: beyond the shared 96k window, so both ends must survive.
  const research = `${HEAD}\n${"h".repeat(60_000)}${MIDDLE}${"m".repeat(60_000)}${TAIL}`;

  it("judge consolidate leaves the drafter window unchanged", () => {
    const drafter = clipSharedDoc("RESEARCH.md", research, docPath);
    // Judges run consolidateText on the excerpt the orchestrator already clipped.
    const judge = consolidateText(drafter, JUDGE_DOC_EXCERPT_MAX_CHARS);
    assert.equal(judge, drafter);
    assert.ok(drafter.includes(HEAD), "head section lost");
    assert.ok(drafter.includes(TAIL), "tail section lost");
    assert.ok(!drafter.includes(MIDDLE), "middle should be clipped past the budget");
    assert.ok(
      drafter.includes(`read_file \`${docPath}\``),
      "truncation hint must name the real phase-relative path",
    );
    assert.ok(drafter.length <= JUDGE_DOC_EXCERPT_MAX_CHARS);
  });

  it("slim draft retry uses the smaller head+tail window", () => {
    const full = clipDraftResearch(research, docPath, false);
    const slim = clipDraftResearch(research, docPath, true);
    assert.equal(full, clipSharedDoc("RESEARCH.md", research, docPath));
    assert.ok(slim.includes(HEAD));
    assert.ok(slim.includes(TAIL));
    assert.ok(!slim.includes(MIDDLE));
    assert.ok(slim.length <= SLIM_RESEARCH_CLIP_CHARS);
    assert.ok(slim.length < full.length);
  });

  it("passes small docs through and labels empty ones", () => {
    assert.equal(clipSharedDoc("RESEARCH.md", "short doc", docPath), "short doc");
    assert.equal(clipSharedDoc("RESEARCH.md", "   ", docPath), "(RESEARCH.md: none)");
  });
});

describe("self-heal draft issue handoff", () => {
  it("prefers structured issues over splitting the joined detail", () => {
    assert.deepEqual(
      nextSelfHealDraftIssues("a; b", ["a; b", " a; b ", "c"]),
      ["a; b", "c"],
      "a gap containing \"; \" must survive intact and duplicates must collapse",
    );
  });

  it("falls back to splitting the detail when no issues are stored", () => {
    assert.deepEqual(nextSelfHealDraftIssues("one; two"), ["one", "two"]);
  });
});

describe("draft research window", () => {
  const docPath = ".slopcontrol/phases/196-x/RESEARCH.md";
  const research = `${"h".repeat(100_000)}TAIL_TOKEN`;

  it("uses the slim budget only for the slim retry and keeps the tail", () => {
    const full = clipDraftResearch(research, docPath, false);
    const slim = clipDraftResearch(research, docPath, true);
    assert.ok(full.length > slim.length);
    assert.ok(slim.length <= SLIM_RESEARCH_CLIP_CHARS + 64);
    assert.ok(full.includes("TAIL_TOKEN"));
    assert.ok(slim.includes("TAIL_TOKEN"));
    assert.ok(slim.includes(`read_file \`${docPath}\``));
  });
});

describe("research leg inherits the last planning-gate gaps", () => {
  it("renders a numbered feedback list from a planning diagnosis", () => {
    const root = mkdtempSync(join(tmpdir(), "planning-research-feedback-"));
    try {
      writeDiagnosis(root, "run-1", draftRejectionDiagnosis(), "01-access");
      const feedback = planningGateFeedbackFromLatestDiagnosis(root, "01-access");
      assert.match(feedback, /^1\. Automated Check 3 greps/);
      assert.ok(feedback.includes(GAPS[1]!));
      assert.ok(feedback.includes(GAPS[2]!));
      // Semicolons inside a gap survive (structured issues[]).
      assert.match(feedback, /contains no literal `token:read`; the check fails/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores non-planning diagnoses and missing ones", () => {
    const root = mkdtempSync(join(tmpdir(), "planning-research-feedback-skip-"));
    try {
      assert.equal(planningGateFeedbackFromLatestDiagnosis(root, "01-access"), "");
      writeDiagnosis(
        root,
        "run-2",
        {
          audience: "coding",
          operatorActions: [],
          class: "infra",
          confidence: "high",
          title: "Verify failed: docker compose up",
          rootCause: "service unavailable",
          evidence: "service unavailable",
          nextActions: "retry_verify",
          fingerprint: "infra-1",
          codingAgentShouldFix: false,
          tags: ["verify", "infra"],
          phaseId: "01-access",
          runId: "run-2",
          updatedAt: new Date().toISOString(),
        },
        "01-access",
      );
      assert.equal(planningGateFeedbackFromLatestDiagnosis(root, "01-access"), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
