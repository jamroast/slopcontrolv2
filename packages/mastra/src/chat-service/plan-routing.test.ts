import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composePlanContinueMessage,
  decidePlanTurn,
  formatPlanTurnRoutingPrefix,
  hasPlanAcceptanceTicks,
  parseLoopIdFromDispatch,
  parsePlanLoopStatusFromDispatch,
} from "./plan-routing.js";

describe("plan-routing", () => {
  it("parseLoopIdFromDispatch reads envelope header", () => {
    assert.equal(
      parseLoopIdFromDispatch("loopId: abc-123\nstatus: open\n---\n{}"),
      "abc-123",
    );
  });

  it("parsePlanLoopStatusFromDispatch reads status header", () => {
    assert.equal(
      parsePlanLoopStatusFromDispatch("loopId: x\nstatus: accepted\n---\n{}"),
      "accepted",
    );
  });

  it("hasPlanAcceptanceTicks detects acceptedFeatureIds", () => {
    assert.equal(
      hasPlanAcceptanceTicks({ acceptedFeatureIds: ["goal"] }),
      true,
    );
    assert.equal(hasPlanAcceptanceTicks({}), false);
  });

  it("decidePlanTurn stays ambiguous without the classifier", () => {
    const d = decidePlanTurn({
      operatorMessage: "Please try again — the plan did not update",
      latch: { loopId: "loop-1", status: "open", currentVersion: 1 },
    });
    assert.equal(d.action, "ambiguous");
    assert.equal(
      decidePlanTurn({ operatorMessage: "try again", latch: null }).action,
      "unrelated",
    );
    assert.equal(
      decidePlanTurn({
        operatorMessage: "",
        latch: { loopId: "loop-1" },
      }).action,
      "ambiguous",
    );
  });

  it("composePlanContinueMessage merges chat and loop context", () => {
    const out = composePlanContinueMessage({
      operatorMessage: "Flesh out Likely areas",
      chatMessages: [
        { role: "user", content: "Need provider-config API details" },
        { role: "assistant", content: "I'll check the plan" },
      ],
      loopUserMessages: ["Need provider-config API details"],
    });
    assert.match(out, /Flesh out Likely areas/);
    assert.match(out, /provider-config/);
  });

  it("formatPlanTurnRoutingPrefix steers away from plan_loop_get", () => {
    const prefix = formatPlanTurnRoutingPrefix({
      latch: { loopId: "loop-1", currentVersion: 1 },
      decision: { action: "continue", reason: "test" },
    });
    assert.match(prefix, /plan_loop_continue/);
    assert.match(prefix, /do NOT call plan_loop_get/i);
  });
});
