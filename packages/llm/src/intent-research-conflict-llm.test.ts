import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IntentResearchConflictSchema } from "./intent-research-conflict-llm.js";

describe("IntentResearchConflictSchema", () => {
  it("accepts a list of conflicts with rejected wording + correction", () => {
    const parsed = IntentResearchConflictSchema.parse({
      conflicts: [
        {
          rejectedWording: "--packages=external",
          correction: "use targeted externals per research",
        },
      ],
    });
    assert.equal(parsed.conflicts.length, 1);
    assert.equal(parsed.conflicts[0]!.rejectedWording, "--packages=external");
  });

  it("accepts an empty conflict list", () => {
    const parsed = IntentResearchConflictSchema.parse({ conflicts: [] });
    assert.deepEqual(parsed.conflicts, []);
  });

  it("rejects malformed payloads", () => {
    assert.throws(() => IntentResearchConflictSchema.parse({}));
    assert.throws(() =>
      IntentResearchConflictSchema.parse({ conflicts: "yes" }),
    );
  });
});
