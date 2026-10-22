import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mergePlanningIssueLedger, normalizeGap } from "./diagnosis.js";
import {
  readLatestDiagnosisForPhase,
  sha256Hex,
  writeDiagnosisWithLedger,
  type PersistedDiagnosis,
} from "./index.js";

describe("normalizeGap", () => {
  it("collapses code fences, quotes and punctuation variants to one key", () => {
    assert.equal(normalizeGap("Check 7 uses bare `npm test` without a path."), normalizeGap("check 7 uses bare npm test without a path"));
    assert.equal(normalizeGap('grep "version": 2'), normalizeGap("grep version 2!"));
    // Distinct content is NOT collapsed.
    assert.notEqual(normalizeGap("npm test"), normalizeGap("pnpm test"));
  });
});

describe("writeDiagnosisWithLedger", () => {
  const planningDiag = (over: Partial<PersistedDiagnosis>): PersistedDiagnosis => ({
    audience: "coding",
    operatorActions: [],
    class: "process",
    confidence: "high",
    title: "Draft rejected",
    rootCause: "x",
    evidence: "x",
    nextActions: "Retry draft.",
    fingerprint: "planning-draft-failed-abc",
    codingAgentShouldFix: true,
    tags: ["planning", "draft", "draft-failed"],
    updatedAt: new Date().toISOString(),
    ...over,
  });

  it("merges the prior ledger on a planning diagnosis", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-ledger-write-"));
    writeDiagnosisWithLedger(
      root,
      "run-1",
      planningDiag({
        phaseId: "p1",
        openIssues: ["bare npm test"],
        draftIssues: ["bare npm test"],
        researchReruns: 1,
        researchHash: sha256Hex("research v1"),
      }),
      "p1",
    );
    writeDiagnosisWithLedger(
      root,
      "run-2",
      planningDiag({
        phaseId: "p1",
        openIssues: ["missing verdict token"],
        draftIssues: ["missing verdict token"],
      }),
      "p1",
    );
    const persisted = readLatestDiagnosisForPhase(root, "p1")!;
    assert.deepEqual([...(persisted.openIssues ?? [])].sort(), [
      "bare npm test",
      "missing verdict token",
    ]);
    // researchReruns / researchHash carry forward when the new write omits them.
    assert.equal(persisted.researchReruns, 1);
    assert.equal(persisted.researchHash, sha256Hex("research v1"));
  });

  it("re-stamps the prior ledger on a verify (non-planning) diagnosis", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-ledger-verify-"));
    writeDiagnosisWithLedger(
      root,
      "run-1",
      planningDiag({
        phaseId: "p1",
        openIssues: ["bare npm test"],
        draftIssues: ["bare npm test"],
        researchReruns: 2,
      }),
      "p1",
    );
    // A verify-flavored failure (no planning tag, no planning fingerprint).
    writeDiagnosisWithLedger(
      root,
      "run-2",
      {
        ...planningDiag({}),
        phaseId: "p1",
        title: "Verify failed: tests",
        fingerprint: "verify-abc123",
        tags: ["verify"],
      },
      "p1",
    );
    const persisted = readLatestDiagnosisForPhase(root, "p1")!;
    assert.equal(persisted.title, "Verify failed: tests");
    assert.deepEqual(persisted.openIssues, ["bare npm test"]);
    assert.equal(persisted.researchReruns, 2);
  });

  it("drops the ledger on a complete stub (phase finished)", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-ledger-complete-"));
    writeDiagnosisWithLedger(
      root,
      "run-1",
      planningDiag({
        phaseId: "p1",
        openIssues: ["bare npm test"],
        draftIssues: ["bare npm test"],
      }),
      "p1",
    );
    writeDiagnosisWithLedger(
      root,
      "run-2",
      {
        ...planningDiag({}),
        phaseId: "p1",
        title: "Phase complete",
        fingerprint: "complete",
        tags: [],
      },
      "p1",
    );
    const persisted = readLatestDiagnosisForPhase(root, "p1")!;
    assert.equal(persisted.openIssues, undefined);
    assert.equal(persisted.draftIssues, undefined);
  });
});

describe("mergePlanningIssueLedger", () => {
  it("accumulates gaps across verdicts and subtracts resolvedGaps", () => {
    const first = mergePlanningIssueLedger(null, {
      gaps: ["bare npm test", "brittle grep"],
      resolvedGaps: [],
      researchFaults: ["brittle grep"],
      draftFaults: ["bare npm test"],
    });
    assert.deepEqual(first.researchIssues, ["brittle grep"]);
    assert.deepEqual(first.draftIssues, ["bare npm test"]);
    // openIssues is the union of the attribution buckets.
    assert.deepEqual([...first.openIssues].sort(), ["bare npm test", "brittle grep"]);

    const second = mergePlanningIssueLedger(first, {
      gaps: ["bare npm test", "new gap"],
      resolvedGaps: ["brittle grep"],
      researchFaults: ["new gap"],
      draftFaults: ["bare npm test"],
    });
    assert.deepEqual(second.researchIssues, ["new gap"]);
    assert.deepEqual(second.draftIssues, ["bare npm test"]);
    assert.deepEqual([...second.openIssues].sort(), ["bare npm test", "new gap"]);
  });

  it("derives openIssues from the attribution split (not the raw gaps)", () => {
    // The judge may word `gaps` differently than its attribution. The ledger
    // must key off the attribution so research-regen subtraction lines up.
    const ledger = mergePlanningIssueLedger(null, {
      gaps: ["RESEARCH does not quote docs/llms-full.txt wording, so the doc check is ungrounded"],
      resolvedGaps: [],
      researchFaults: ["RESEARCH does not quote docs/llms-full.txt wording"],
      draftFaults: [],
    });
    assert.deepEqual(ledger.researchIssues, [
      "RESEARCH does not quote docs/llms-full.txt wording",
    ]);
    assert.deepEqual(ledger.draftIssues, []);
    assert.deepEqual(ledger.openIssues, [
      "RESEARCH does not quote docs/llms-full.txt wording",
    ]);
  });

  it("resolves gaps case/whitespace-insensitively", () => {
    const ledger = mergePlanningIssueLedger(
      {
        openIssues: ["Bare npm test", "Brittle grep"],
        researchIssues: ["Brittle grep"],
        draftIssues: ["Bare npm test"],
      },
      {
        gaps: [],
        resolvedGaps: ["  bare   npm test "],
        researchFaults: [],
        draftFaults: [],
      },
    );
    assert.deepEqual(ledger.draftIssues, []);
    assert.deepEqual(ledger.researchIssues, ["Brittle grep"]);
    assert.deepEqual(ledger.openIssues, ["Brittle grep"]);
  });

  it("defaults un-attributed gaps to draftIssues (mirroring faultLeg)", () => {
    const ledger = mergePlanningIssueLedger(null, {
      gaps: ["un-attributed rejection gap"],
      resolvedGaps: [],
      researchFaults: [],
      draftFaults: [],
    });
    assert.deepEqual(ledger.researchIssues, []);
    assert.deepEqual(ledger.draftIssues, ["un-attributed rejection gap"]);
    assert.deepEqual(ledger.openIssues, ["un-attributed rejection gap"]);
  });
});
