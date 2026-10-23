import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  docRevisionChanged,
  normalizeDocForCompare,
  verifyDocRevisionApplied,
} from "./verify-doc-revision.js";

describe("normalizeDocForCompare", () => {
  it("strips date lines and trailing whitespace", () => {
    const a = "# Title\n\nDate: 2025-01-01\n\nBody  \n";
    const b = "# Title\n\nDate: 2025-02-02\n\nBody\n";
    assert.equal(normalizeDocForCompare(a), normalizeDocForCompare(b));
  });

  it("detects real content changes", () => {
    assert.notEqual(
      normalizeDocForCompare("# Title\n\nBody A"),
      normalizeDocForCompare("# Title\n\nBody B"),
    );
  });
});

describe("docRevisionChanged", () => {
  it("true when content differs", () => {
    assert.equal(docRevisionChanged("a", "b"), true);
  });
  it("false when only the date differs", () => {
    assert.equal(
      docRevisionChanged("Date: 2025-01-01\nx", "Date: 2025-02-02\nx"),
      false,
    );
  });
});

describe("verifyDocRevisionApplied", () => {
  it("passes a changed doc with no judge (best-effort)", async () => {
    const v = await verifyDocRevisionApplied({
      before: "old",
      after: "new",
      feedback: "change it",
    });
    assert.equal(v.ok, true);
    assert.equal(v.changed, true);
  });

  it("fails closed on byte-identical with no judge", async () => {
    const v = await verifyDocRevisionApplied({
      before: "same",
      after: "same",
      feedback: "change it",
    });
    assert.equal(v.ok, false);
    assert.equal(v.changed, false);
  });

  it("judge confirms a no-op is correct when feedback already satisfied", async () => {
    const v = await verifyDocRevisionApplied({
      before: "env keys present",
      after: "env keys present",
      feedback: "confirm env keys are present",
      judge: async () => ({ applied: ["confirm env keys"], missing: [] }),
    });
    assert.equal(v.ok, true);
    assert.equal(v.changed, false);
    assert.equal(v.reason, "no-op (feedback already satisfied)");
  });

  it("judge flags missing feedback", async () => {
    const v = await verifyDocRevisionApplied({
      before: "old",
      after: "new",
      feedback: "add the issuer config",
      judge: async () => ({ applied: [], missing: ["add the issuer config"] }),
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ["add the issuer config"]);
  });

  it("routes development-stage feedback as unfulfillable, never missing", async () => {
    const v = await verifyDocRevisionApplied({
      before: "old",
      after: "new",
      feedback: "CREATE src/lib/db/auth-events-schema.test.ts on disk",
      judge: async () => ({
        applied: [],
        missing: [],
        unfulfillable: [
          {
            bullet: "CREATE src/lib/db/auth-events-schema.test.ts on disk",
            reason: "plan-revision stage writes planning docs only",
          },
        ],
      }),
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, []);
    assert.deepEqual(v.unfulfillable, [
      "CREATE src/lib/db/auth-events-schema.test.ts on disk — plan-revision stage writes planning docs only",
    ]);
    assert.match(v.reason, /development stage/);
  });

  it("missing still wins over unfulfillable when both are reported", async () => {
    const v = await verifyDocRevisionApplied({
      before: "old",
      after: "old",
      feedback: "fix the check and write the test file",
      judge: async () => ({
        applied: [],
        missing: ["fix the check"],
        unfulfillable: [{ bullet: "write the test file", reason: "" }],
      }),
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ["fix the check"]);
    assert.equal(v.unfulfillable, undefined);
  });

  it("tolerates string-shaped unfulfillable entries", async () => {
    const v = await verifyDocRevisionApplied({
      before: "old",
      after: "new",
      feedback: "add dependency to package.json",
      judge: async () => ({
        applied: [],
        missing: [],
        unfulfillable: ["add dependency to package.json"],
      }),
    });
    assert.equal(v.ok, false);
    assert.deepEqual(v.unfulfillable, ["add dependency to package.json"]);
  });
});


describe("verifyDocRevisionApplied judge outage", () => {
  it("accepts a changed doc when the judge throws, recording judgeError", async () => {
    const verdict = await verifyDocRevisionApplied({
      before: "alpha",
      after: "beta",
      feedback: "change it",
      judge: async () => {
        throw new Error("JSON chat parse failed: \"Let me ana\"");
      },
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.changed, true);
    assert.match(verdict.reason, /judge unavailable/);
    assert.match(verdict.judgeError ?? "", /parse failed/);
  });

  it("fails closed on a byte-identical doc when the judge throws", async () => {
    const verdict = await verifyDocRevisionApplied({
      before: "same",
      after: "same",
      feedback: "change it",
      judge: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /byte-identical/);
    assert.match(verdict.judgeError ?? "", /boom/);
  });
});
