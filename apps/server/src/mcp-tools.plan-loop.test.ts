import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPlanLoopMcpEnvelope } from "./mcp-tools.js";

describe("formatPlanLoopMcpEnvelope plan paging", () => {
  it("emits a plan_slice continuation hint when the plan is sliced", () => {
    const body = JSON.stringify({
      loop: { id: "loop-1", status: "open", currentVersion: 2 },
      loopId: "loop-1",
      version: 2,
      plan: "# PLAN\n\n## Approach\n…chunk one…",
      planTotalChars: 24_000,
      planOffset: 0,
      notes: "operating contract",
    });
    const out = formatPlanLoopMcpEnvelope(body, true);
    assert.match(
      out,
      /plan_slice: chars 0\.\.\d+ of 24000 — call plan_loop_get with offset \d+ for the next chunk/,
    );
    assert.match(out, /# PLAN/);
  });

  it("omits the hint when the whole plan fit in one slice", () => {
    const plan = "# PLAN\n\nshort plan";
    const body = JSON.stringify({
      loop: { id: "loop-1", status: "open", currentVersion: 1 },
      loopId: "loop-1",
      version: 1,
      plan,
      planTotalChars: plan.length,
      planOffset: 0,
    });
    const out = formatPlanLoopMcpEnvelope(body, true);
    assert.ok(!out.includes("plan_slice:"), out);
  });

  it("prints planChars and tells the caller when the body was omitted", () => {
    const body = JSON.stringify({
      loop: { id: "loop-1", status: "open", currentVersion: 2 },
      loopId: "loop-1",
      version: 2,
      plan: null,
      planTotalChars: 9780,
      planOmitted: true,
      notes: "Full-revise plan below.",
      versions: { tip: 2, versions: [] },
    });
    const out = formatPlanLoopMcpEnvelope(body, true);
    assert.match(out, /planChars: 9780/);
    assert.match(out, /plan body omitted — call plan_loop_get without includePlan=false/);
    assert.match(out, /notes: Full-revise plan below\./);
  });

  it("omits the hint for legacy responses without paging fields", () => {
    const body = JSON.stringify({
      loop: { id: "loop-1", status: "open", currentVersion: 1 },
      loopId: "loop-1",
      version: 1,
      plan: "# PLAN\n\nshort plan",
    });
    const out = formatPlanLoopMcpEnvelope(body, true);
    assert.ok(!out.includes("plan_slice:"), out);
  });
});
