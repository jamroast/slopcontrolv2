import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePlanningIssueLedger } from "./diagnosis.js";

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
