import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
});
