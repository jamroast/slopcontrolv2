import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CapabilityContradictionSchema } from "./capability-contradiction-llm.js";

describe("capability contradiction schema", () => {
  it("accepts an empty list and an exact prohibition", () => {
    assert.deepEqual(
      CapabilityContradictionSchema.parse({ contradictions: [] }).contradictions,
      [],
    );
    const parsed = CapabilityContradictionSchema.parse({
      contradictions: [
        { mustNot: "Do not link /feed.txt", capability: "/feed.txt" },
      ],
    });
    assert.equal(parsed.contradictions[0]?.capability, "/feed.txt");
  });
});
