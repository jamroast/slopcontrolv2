import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IntentResearchConflictSchema } from "./intent-research-conflict-llm.js";

describe("IntentResearchConflictSchema", () => {
  it("accepts a conflict with rejected wording + correction", () => {
    const parsed = IntentResearchConflictSchema.parse({
      hasConflict: true,
      rejectedWording: "--packages=external",
      correction: "use targeted externals per research",
    });
    assert.equal(parsed.hasConflict, true);
    assert.equal(parsed.rejectedWording, "--packages=external");
  });

  it("accepts a no-conflict result", () => {
    const parsed = IntentResearchConflictSchema.parse({ hasConflict: false });
    assert.equal(parsed.hasConflict, false);
    assert.equal(parsed.rejectedWording, undefined);
  });

  it("rejects malformed payloads", () => {
    assert.throws(() => IntentResearchConflictSchema.parse({}));
    assert.throws(() =>
      IntentResearchConflictSchema.parse({ hasConflict: "yes" }),
    );
  });
});
