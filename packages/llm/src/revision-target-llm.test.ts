import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RevisionTargetSchema } from "./revision-target-llm.js";
import { DocRevisionJudgeSchema } from "./doc-revision-judge-llm.js";

describe("RevisionTargetSchema", () => {
  it("accepts research/phase/both", () => {
    assert.equal(RevisionTargetSchema.parse({ targets: "research" }).targets, "research");
    assert.equal(RevisionTargetSchema.parse({ targets: "phase" }).targets, "phase");
    assert.equal(RevisionTargetSchema.parse({ targets: "both" }).targets, "both");
  });
  it("rejects unknown targets", () => {
    assert.throws(() => RevisionTargetSchema.parse({ targets: "nope" }));
  });
});

describe("DocRevisionJudgeSchema", () => {
  it("accepts applied/missing arrays", () => {
    const parsed = DocRevisionJudgeSchema.parse({
      applied: ["a"],
      missing: ["b"],
    });
    assert.deepEqual(parsed.applied, ["a"]);
    assert.deepEqual(parsed.missing, ["b"]);
  });
  it("rejects malformed payloads", () => {
    assert.throws(() => DocRevisionJudgeSchema.parse({}));
  });
});
