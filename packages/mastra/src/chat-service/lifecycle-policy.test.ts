import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunStageSchema, type RunStage } from "@slopcontrol/types";
import {
  ADVANCE_EVENT_TYPES,
  decideAdvance,
  eventForType,
  parseAdvanceEvent,
  type AdvanceDecision,
  type AdvanceEventType,
} from "./lifecycle-policy.js";

type Expected = { kind: AdvanceDecision["kind"]; tool?: string };

const EXPECTED = {
  idle: {
    proceed: { kind: "stop" },
    command_ok: { kind: "stop" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  researching: {
    proceed: { kind: "working" },
    command_ok: { kind: "working" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  drafting: {
    proceed: { kind: "working" },
    command_ok: { kind: "working" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  in_review: {
    proceed: { kind: "dispatch", tool: "submit_review" },
    command_ok: { kind: "dispatch", tool: "submit_review" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  accepted: {
    proceed: { kind: "dispatch", tool: "start_development" },
    command_ok: { kind: "dispatch", tool: "start_development" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  designing: {
    proceed: { kind: "working" },
    command_ok: { kind: "working" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  design_complete: {
    proceed: { kind: "dispatch", tool: "start_development" },
    command_ok: { kind: "dispatch", tool: "start_development" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  developing: {
    proceed: { kind: "working" },
    command_ok: { kind: "working" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  complete: {
    proceed: { kind: "stop" },
    command_ok: { kind: "stop" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  blocked: {
    proceed: { kind: "stop" },
    command_ok: { kind: "stop" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  failed: {
    proceed: { kind: "stop" },
    command_ok: { kind: "stop" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
  interrupted: {
    proceed: { kind: "stop" },
    command_ok: { kind: "stop" },
    design_required: { kind: "dispatch", tool: "start_design" },
    review_required: { kind: "dispatch", tool: "submit_review" },
    already_running: { kind: "working" },
    unknown_error: { kind: "stop" },
  },
} as const satisfies Record<RunStage, Record<AdvanceEventType, Expected>>;

describe("decideAdvance matrix", () => {
  it("covers every RunStage × AdvanceEvent", () => {
    for (const stage of RunStageSchema.options) {
      for (const eventType of ADVANCE_EVENT_TYPES) {
        const expected = EXPECTED[stage][eventType];
        const actual = decideAdvance(stage, eventForType(eventType));
        assert.equal(
          actual.kind,
          expected.kind,
          `${stage} + ${eventType} kind`,
        );
        if (expected.kind === "dispatch") {
          assert.equal(
            actual.kind === "dispatch" ? actual.tool : "",
            expected.tool,
            `${stage} + ${eventType} tool`,
          );
        }
      }
    }
  });

  it("proceed from accepted uses autoDesign", () => {
    const d = decideAdvance("accepted", { type: "proceed" });
    assert.equal(d.kind, "dispatch");
    if (d.kind === "dispatch") {
      assert.equal(d.args.autoDesign, true);
    }
  });
});

describe("parseAdvanceEvent", () => {
  it("prefers structured error codes over free text", () => {
    assert.equal(
      parseAdvanceEvent('ERROR:\n{"error":"design_required"}').type,
      "design_required",
    );
    assert.equal(
      parseAdvanceEvent(JSON.stringify({ error: "development_in_progress" }))
        .type,
      "already_running",
    );
    assert.equal(
      parseAdvanceEvent(
        '{"error":"Phase must be accepted or design_complete before development can start","stage":"in_review"}',
      ).type,
      "review_required",
    );
    assert.equal(parseAdvanceEvent("nope").type, "unknown_error");
  });
});
