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
});
