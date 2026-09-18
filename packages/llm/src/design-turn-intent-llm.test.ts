import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESIGN_TURN_INTENT_SYSTEM_PROMPT,
  DesignTurnIntentSchema,
} from "./design-turn-intent-llm.js";

describe("DesignTurnIntentSchema", () => {
  it("accepts the four routing actions", () => {
    for (const action of ["continue", "accept", "status", "unrelated"]) {
      const parsed = DesignTurnIntentSchema.parse({ action });
      assert.equal(parsed.action, action);
    }
  });

  it("rejects plan-only actions", () => {
    assert.throws(() => DesignTurnIntentSchema.parse({ action: "promote" }));
    assert.throws(() => DesignTurnIntentSchema.parse({ action: "new_loop" }));
  });

  it("system prompt covers finalized loops being reopened by continue", () => {
    assert.match(DESIGN_TURN_INTENT_SYSTEM_PROMPT, /accepted\/implemented/);
    assert.match(DESIGN_TURN_INTENT_SYSTEM_PROMPT, /reopens it and iterates/);
    assert.match(DESIGN_TURN_INTENT_SYSTEM_PROMPT, /not unrelated/);
  });
});
