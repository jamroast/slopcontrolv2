import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildDevelopmentHandoff,
  buildRequirementsFromPhase,
  extractSuccessCriteriaBullets,
  formatHandoffMarkdown,
  handoffSummary,
  harvestOperatorHandoffFromAppendix,
  readLatestHandoffForPhase,
  readRunHandoff,
  writeDevelopmentHandoff,
} from "./development-handoff.js";
import { ensureSlopcontrolDir } from "./index.js";

describe("development handoff", () => {
  it("harvests Operator handoff sections from APPENDIX", () => {
    const appendix = `# Appendix

## Iteration 1

noise

## Operator handoff

### Operator requirements
- Run \`npm run db:migrate\` once on staging
- None

### Knowledge
- drizzle/ is gitignored; keep worktree and root in sync

### Follow-ups
- Start phase 36 for Clerk webhook hardening
`;
    const h = harvestOperatorHandoffFromAppendix(appendix);
    assert.equal(h.found, true);
    assert.deepEqual(h.operatorRequirements, [
      "Run `npm run db:migrate` once on staging",
    ]);
    assert.deepEqual(h.knowledge, [
      "drizzle/ is gitignored; keep worktree and root in sync",
    ]);
    assert.deepEqual(h.followUps, [
      "Start phase 36 for Clerk webhook hardening",
    ]);
  });

  it("returns empty harvest when section missing", () => {
    const h = harvestOperatorHandoffFromAppendix("## Iteration 1\n\nok\n");
    assert.equal(h.found, false);
    assert.deepEqual(h.operatorRequirements, []);
  });

  it("builds complete handoff with met requirements", () => {
    const phaseDoc = `# Phase

## Success Criteria
- Canvas persists to IndexedDB
- npm test passes

## Automated Checks
\`\`\`bash
true
\`\`\`
`;
    const handoff = buildDevelopmentHandoff({
      outcome: "complete",
      phaseId: "01-scaffold",
      runId: "run-1",
      phaseDoc,
      appendix: "",
      checksOk: true,
      checksSummary: "All checks passed",
      merge: { autoMerged: true, worktreePresent: false, commit: "abc123" },
    });
    assert.equal(handoff.outcome, "complete");
    assert.equal(handoff.source, "orchestrator");
    assert.equal(handoff.requirements.length, 2);
    assert.ok(handoff.requirements.every((r) => r.status === "met"));
    assert.match(handoff.summary, /completed successfully/i);
  });

  it("omits stale diagnosis on complete handoff", () => {
    const handoff = buildDevelopmentHandoff({
      outcome: "complete",
      phaseId: "01-scaffold",
      runId: "run-1",
      phaseDoc: `# Phase\n\n## Success Criteria\n- Done\n`,
      appendix: "",
      checksOk: true,
      merge: { autoMerged: true, worktreePresent: false },
      diagnosis: {
        fingerprint: "fail-fp",
        title: "Build, typecheck, or test assertion failure",
        class: "product",
      },
    });
    assert.equal(handoff.diagnosis, undefined);
    assert.doesNotMatch(formatHandoffMarkdown(handoff), /## Diagnosis/);
  });

  it("builds blocked handoff with diagnosis actions", () => {
    const handoff = buildDevelopmentHandoff({
      outcome: "blocked",
      phaseId: "02-x",
      runId: "run-2",
      phaseDoc: `# Phase\n\n## Success Criteria\n- Done\n`,
      appendix: `## Operator handoff\n\n### Knowledge\n- DB was down\n`,
      checksOk: false,
      diagnosis: {
        fingerprint: "abc",
        title: "Infra down",
        class: "infra",
        operatorActions: ["Start postgres via docker compose"],
      },
    });
    assert.equal(handoff.outcome, "blocked");
    assert.equal(handoff.source, "both");
    assert.ok(
      handoff.operatorRequirements.includes("Start postgres via docker compose"),
    );
    assert.ok(
      handoff.nextSteps.some((s) => /get_operator_suggestions/i.test(s)),
    );
    assert.equal(handoff.requirements[0]?.status, "unmet");
  });

  it("writes and reads handoff.json + HANDOFF.md", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-handoff-"));
    try {
      ensureSlopcontrolDir(root);
      const handoff = buildDevelopmentHandoff({
        outcome: "complete",
        phaseId: "03-a",
        runId: "run-3",
        phaseDoc: `# Phase\n\n## Success Criteria\n- Ship it\n`,
        appendix: `## Operator handoff\n\n### Operator requirements\n- Rotate API key\n`,
        checksOk: true,
        merge: { autoMerged: true, worktreePresent: false },
      });
      const paths = writeDevelopmentHandoff(root, {
        phaseId: "03-a",
        runId: "run-3",
        handoff,
      });
      assert.ok(existsSync(paths.phaseJson));
      assert.ok(existsSync(paths.runJson));
      assert.ok(existsSync(paths.phaseMd));
      const fromPhase = readLatestHandoffForPhase(root, "03-a");
      const fromRun = readRunHandoff(root, "run-3");
      assert.equal(fromPhase?.outcome, "complete");
      assert.equal(fromRun?.operatorRequirements[0], "Rotate API key");
      const md = readFileSync(paths.phaseMd, "utf-8");
      assert.match(md, /Rotate API key/);
      assert.match(formatHandoffMarkdown(handoff), /Development handoff/);
      const summary = handoffSummary(fromPhase);
      assert.equal(summary?.operatorRequirementsCount, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts Success Criteria bullets", () => {
    const bullets = extractSuccessCriteriaBullets(`# Phase

## Success Criteria
- One
- Two

## Automated Checks
\`\`\`bash
true
\`\`\`
`);
    assert.deepEqual(bullets, ["One", "Two"]);
  });

  it("extracts numbered Success Criteria with bold titles", () => {
    const bullets = extractSuccessCriteriaBullets(`# Phase

## Success Criteria

These are the acceptance criteria:

1. **Fresh-volume bootstrap works**
   \`docker compose down -v\` succeeds, then migrate exits 0.
2. **All Phase-02 tables present**
   \`pnpm manage db tables\` lists the 16 expected tables.
3. **Journal is seeded**
   Exactly 2 applied migrations.

## Automated Checks
\`\`\`bash
true
\`\`\`
`);
    assert.deepEqual(bullets, [
      "Fresh-volume bootstrap works",
      "All Phase-02 tables present",
      "Journal is seeded",
    ]);
    const reqs = buildRequirementsFromPhase(
      `# Phase\n\n## Success Criteria\n\n1. **Fresh-volume bootstrap works**\n\n`,
      true,
    );
    assert.equal(reqs[0]?.text, "Fresh-volume bootstrap works");
    assert.equal(reqs[0]?.status, "met");
    assert.doesNotMatch(reqs[0]?.text ?? "", /none listed/i);
  });
});
