import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideDesignTurn,
  DESIGN_LOOP_ID_DEPENDENT_TOOLS,
  formatDesignLoopLatchPrompt,
  formatDesignTurnRoutingPrefix,
  isDesignLoopOpen,
  parseDesignLoopStatusFromDispatch,
  parseDesignLoopVersionFromDispatch,
  parseLoopDiscardVersion,
} from "./design-routing.js";
import { parseLoopIdFromDispatch } from "./plan-routing.js";

describe("design routing", () => {
  it("isDesignLoopOpen only treats open/undefined as open", () => {
    assert.equal(isDesignLoopOpen(undefined), true);
    assert.equal(isDesignLoopOpen("open"), true);
    assert.equal(isDesignLoopOpen("accepted"), false);
    assert.equal(isDesignLoopOpen("implemented"), false);
  });

  it("decideDesignTurn is unrelated without an open latch", () => {
    assert.deepEqual(
      decideDesignTurn({ operatorMessage: "make it darker", latch: null }),
      { action: "unrelated", reason: "no open design latch" },
    );
    assert.deepEqual(
      decideDesignTurn({
        operatorMessage: "make it darker",
        latch: { loopId: "d1", status: "accepted" },
      }),
      { action: "unrelated", reason: "no open design latch" },
    );
  });

  it("decideDesignTurn stays ambiguous when classification is needed", () => {
    assert.deepEqual(
      decideDesignTurn({
        operatorMessage: "make it darker",
        latch: { loopId: "d1", status: "open" },
      }),
      { action: "ambiguous", reason: "need classifier" },
    );
    assert.deepEqual(
      decideDesignTurn({
        operatorMessage: "  ",
        latch: { loopId: "d1", status: "open" },
      }),
      { action: "ambiguous", reason: "empty operator message" },
    );
  });

  it("formatDesignLoopLatchPrompt points feedback at continue", () => {
    const text = formatDesignLoopLatchPrompt({
      loopId: "d1",
      title: "login page mock",
      currentVersion: 3,
      status: "open",
    });
    assert.match(text, /loopId: d1/);
    assert.match(text, /v3/);
    assert.match(text, /design_loop_continue/);
    assert.match(text, /NOT design_loop_get/);
  });

  it("id-dependent set covers revision, handoff, and terminal tools", () => {
    for (const tool of [
      "design_loop_get",
      "design_loop_continue",
      "design_loop_accept",
      "design_loop_discard",
      "design_loop_retry",
      "implement_design",
      "relaunch_design_research",
    ]) {
      assert.ok(DESIGN_LOOP_ID_DEPENDENT_TOOLS.has(tool), tool);
    }
    assert.ok(!DESIGN_LOOP_ID_DEPENDENT_TOOLS.has("design_loop_start"));
  });

  it("formatDesignTurnRoutingPrefix steers away from design_loop_get", () => {
    const latch = { loopId: "d1", currentVersion: 3, status: "open" };
    const cont = formatDesignTurnRoutingPrefix({
      latch,
      decision: { action: "continue", reason: "visual feedback" },
    });
    assert.match(cont, /MUST park design_loop_continue/);
    assert.match(cont, /do NOT call design_loop_get/);
    const status = formatDesignTurnRoutingPrefix({
      latch,
      decision: { action: "status", reason: "checking" },
    });
    assert.match(status, /Read-only status check is OK/);
    assert.equal(
      formatDesignTurnRoutingPrefix({
        latch,
        decision: { action: "unrelated", reason: "off topic" },
      }),
      "",
    );
  });

  it("parses status from envelope header and JSON body", () => {
    assert.equal(
      parseDesignLoopStatusFromDispatch("loopId: d1\nstatus: open\n---\n{}"),
      "open",
    );
    assert.equal(
      parseDesignLoopStatusFromDispatch('{"loop":{"status":"accepted"}}'),
      "accepted",
    );
    assert.equal(parseDesignLoopStatusFromDispatch("not json"), undefined);
  });

  it("parses version from JSON body", () => {
    assert.equal(
      parseDesignLoopVersionFromDispatch('{"version":4}'),
      4,
    );
    assert.equal(
      parseDesignLoopVersionFromDispatch('{"loop":{"currentVersion":7}}'),
      7,
    );
    assert.equal(parseDesignLoopVersionFromDispatch("not json"), undefined);
  });

  it("parseLoopDiscardVersion reads version from args", () => {
    assert.equal(parseLoopDiscardVersion({ version: 3 }), 3);
    assert.equal(parseLoopDiscardVersion({ version: "5" }), 5);
    assert.equal(parseLoopDiscardVersion({}), undefined);
    assert.equal(parseLoopDiscardVersion({ version: 0 }), undefined);
  });

  it("shared parseLoopIdFromDispatch reads design envelopes", () => {
    assert.equal(
      parseLoopIdFromDispatch("loopId: d-456\nstatus: open\n---\n{}"),
      "d-456",
    );
  });
});
