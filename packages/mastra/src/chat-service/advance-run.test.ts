import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceRun,
  formatAdvanceRunResult,
  shouldAdvanceAfterConfirm,
} from "./advance-run.js";
import { decideAdvance, parseAdvanceEvent } from "./lifecycle-policy.js";

describe("decideAdvance proceed", () => {
  it("maps gates to the next mutating tool and busy stages to working", () => {
    assert.equal(decideAdvance("in_review", { type: "proceed" }).kind, "dispatch");
    assert.equal(
      (decideAdvance("in_review", { type: "proceed" }) as { tool: string }).tool,
      "submit_review",
    );
    assert.equal(
      (decideAdvance("accepted", { type: "proceed" }) as { tool: string }).tool,
      "start_development",
    );
    assert.equal(
      (decideAdvance("design_complete", { type: "proceed" }) as { tool: string })
        .tool,
      "start_development",
    );
    assert.equal(decideAdvance("developing", { type: "proceed" }).kind, "working");
    assert.equal(decideAdvance("designing", { type: "proceed" }).kind, "working");
    assert.equal(decideAdvance("complete", { type: "proceed" }).kind, "stop");
    assert.equal(decideAdvance("blocked", { type: "proceed" }).kind, "stop");
    assert.equal(decideAdvance("idle", { type: "proceed" }).kind, "stop");
  });
});

describe("shouldAdvanceAfterConfirm", () => {
  it("advances proceed tools but not request_changes or research start", () => {
    assert.equal(
      shouldAdvanceAfterConfirm("submit_review", { decision: "approve" }),
      true,
    );
    assert.equal(
      shouldAdvanceAfterConfirm("submit_review", {
        decision: "request_changes",
      }),
      false,
    );
    assert.equal(shouldAdvanceAfterConfirm("start_development", {}), true);
    assert.equal(shouldAdvanceAfterConfirm("start_design", {}), true);
    assert.equal(shouldAdvanceAfterConfirm("advance_run", {}), true);
    assert.equal(shouldAdvanceAfterConfirm("start_change", {}), false);
    assert.equal(shouldAdvanceAfterConfirm("promote_ask", {}), false);
  });
});

describe("advanceRun", () => {
  it("in_review → submit_review → accepted → start_development → developing", async () => {
    let stage = "in_review";
    const tools: string[] = [];
    const result = await advanceRun({
      runId: "run-88",
      projectId: "p1",
      getStage: () => stage,
      dispatch: async (tool) => {
        tools.push(tool);
        if (tool === "submit_review") {
          stage = "accepted";
          return { text: '{"stage":"accepted"}' };
        }
        if (tool === "start_development") {
          stage = "developing";
          return { text: '{"stage":"developing"}' };
        }
        return { text: "unexpected", isError: true };
      },
    });
    assert.deepEqual(tools, ["submit_review", "start_development"]);
    assert.equal(result.kind, "working");
    assert.equal(result.stage, "developing");
    assert.match(formatAdvanceRunResult(result), /submit_review → start_development/);
  });

  it("accepted (the stuck chat case) starts development", async () => {
    let stage = "accepted";
    const tools: string[] = [];
    const result = await advanceRun({
      runId: "run-88",
      getStage: () => stage,
      dispatch: async (tool) => {
        tools.push(tool);
        stage = "developing";
        return { text: '{"stage":"developing"}' };
      },
    });
    assert.deepEqual(tools, ["start_development"]);
    assert.equal(result.kind, "working");
  });

  it("does not dispatch when work is already running", async () => {
    let dispatched = false;
    const result = await advanceRun({
      runId: "run-1",
      getStage: () => "developing",
      dispatch: async () => {
        dispatched = true;
        return { text: "{}" };
      },
    });
    assert.equal(dispatched, false);
    assert.equal(result.kind, "working");
    assert.equal(result.steps.length, 0);
  });

  it("recovers design_required by calling start_design", async () => {
    let stage = "accepted";
    const tools: string[] = [];
    const result = await advanceRun({
      runId: "run-1",
      getStage: () => stage,
      dispatch: async (tool) => {
        tools.push(tool);
        if (tool === "start_development") {
          return {
            text: JSON.stringify({ error: "design_required" }),
            isError: true,
          };
        }
        if (tool === "start_design") {
          stage = "designing";
          return { text: '{"stage":"designing"}' };
        }
        return { text: "no", isError: true };
      },
    });
    assert.deepEqual(tools, ["start_development", "start_design"]);
    assert.equal(result.kind, "working");
    assert.equal(result.stage, "designing");
  });

  it("uses stageHint when the store has not caught up", async () => {
    const tools: string[] = [];
    const result = await advanceRun({
      runId: "run-88",
      stageHint: "accepted",
      getStage: () => undefined,
      dispatch: async (tool) => {
        tools.push(tool);
        return { text: '{"stage":"developing"}' };
      },
    });
    assert.deepEqual(tools, ["start_development"]);
    assert.equal(result.kind, "working");
  });

  it("recovers design_required from a seed error without a prior stage", async () => {
    const tools: string[] = [];
    const result = await advanceRun({
      runId: "run-1",
      seedError: JSON.stringify({ error: "design_required" }),
      getStage: () => undefined,
      dispatch: async (tool) => {
        tools.push(tool);
        return { text: '{"stage":"designing"}' };
      },
    });
    assert.deepEqual(tools, ["start_design"]);
    assert.equal(result.kind, "working");
    assert.equal(result.stage, "designing");
  });

  it("treats development_in_progress as already working", async () => {
    const result = await advanceRun({
      runId: "run-1",
      getStage: () => "accepted",
      dispatch: async () => ({
        text: JSON.stringify({ error: "development_in_progress" }),
        isError: true,
      }),
    });
    assert.equal(result.kind, "working");
  });

  it("stops instead of looping when a gate does not move", async () => {
    const result = await advanceRun({
      runId: "run-1",
      getStage: () => "in_review",
      dispatch: async () => ({ text: '{"stage":"in_review"}' }),
    });
    assert.equal(result.kind, "stop");
    assert.match(result.reason, /Stuck at in_review/);
    assert.equal(result.steps.length, 1);
  });
});

describe("parseAdvanceEvent review_required", () => {
  it("maps the original chat 409 to submit_review", () => {
    const event = parseAdvanceEvent(
      'ERROR:\n{"error":"Phase must be accepted or design_complete before development can start","stage":"in_review"}',
    );
    assert.equal(event.type, "review_required");
    const d = decideAdvance("in_review", event);
    assert.equal(d.kind, "dispatch");
    assert.equal(d.kind === "dispatch" ? d.tool : "", "submit_review");
  });
});
