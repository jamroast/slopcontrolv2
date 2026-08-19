import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlanTurnIntentSchema } from "./plan-turn-intent-llm.js";

describe("plan-turn-intent-llm", () => {
  it("parses continue action", () => {
    assert.equal(
      PlanTurnIntentSchema.parse({ action: "continue" }).action,
      "continue",
    );
  });

  it("parses status action", () => {
    assert.equal(
      PlanTurnIntentSchema.parse({ action: "status", notes: "check" }).action,
      "status",
    );
  });
});
