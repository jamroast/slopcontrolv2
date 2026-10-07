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
