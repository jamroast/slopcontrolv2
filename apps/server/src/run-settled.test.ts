import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TERMINAL_RUN_STAGES, type RunStage } from "@slopcontrol/types";
import {
  shouldNotifyRunGate,
  shouldNotifyRunSettled,
  shouldNotifyRunStageChange,
} from "./run-settled.js";

describe("shouldNotifyRunSettled (touchRunStage choke point)", () => {
  it("notifies on a transition into every terminal stage", () => {
    for (const stage of TERMINAL_RUN_STAGES) {
      assert.equal(
        shouldNotifyRunSettled("developing", stage),
        true,
        `expected notify for developing -> ${stage}`,
      );
    }
  });

  it("does not notify for gate stages via shouldNotifyRunSettled", () => {
    for (const gate of ["in_review", "accepted", "design_complete"] as RunStage[]) {
      assert.equal(shouldNotifyRunSettled("researching", gate), false);
    }
  });

  it("does not notify for busy or idle transitions", () => {
    assert.equal(shouldNotifyRunSettled("idle", "researching"), false);
    assert.equal(shouldNotifyRunSettled("researching", "developing"), false);
  });

  it("does not re-notify when the same stage is touched twice", () => {
    for (const stage of TERMINAL_RUN_STAGES) {
      assert.equal(shouldNotifyRunSettled(stage, stage), false);
    }
  });

  it("notifies again if the run leaves and re-enters a terminal stage", () => {
    assert.equal(shouldNotifyRunSettled("failed", "developing"), false);
    assert.equal(shouldNotifyRunSettled("developing", "failed"), true);
  });
});

describe("shouldNotifyRunGate", () => {
  it("notifies on transitions into gate stages", () => {
    assert.equal(shouldNotifyRunGate("researching", "in_review"), true);
    assert.equal(shouldNotifyRunGate("designing", "design_complete"), true);
  });

  it("does not notify for busy or terminal transitions", () => {
    assert.equal(shouldNotifyRunGate("researching", "developing"), false);
    assert.equal(shouldNotifyRunGate("developing", "complete"), false);
  });
});

describe("shouldNotifyRunStageChange", () => {
  it("combines gate and terminal notifications", () => {
    assert.equal(shouldNotifyRunStageChange("researching", "in_review"), true);
    assert.equal(shouldNotifyRunStageChange("developing", "complete"), true);
    assert.equal(shouldNotifyRunStageChange("researching", "drafting"), false);
  });
});
