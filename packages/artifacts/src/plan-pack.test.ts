import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlanLoopMeta } from "./plan-loop.js";
import {
  compilePlanPackFromAccept,
  phaseDescriptionFromPlanPack,
  type PlanPack,
} from "./plan-pack.js";

// Goal whose "straddleword" token spans the 500-char boundary: `"a ".repeat(245)`
// is 490 chars, then "straddleword" begins at index 490 and runs past 500.
const LONG_GOAL = `${"a ".repeat(245)}straddleword tail`;

function compileGoal(goal: string): PlanPack {
  const meta = createPlanLoopMeta({ projectId: "p1", brief: "fix" });
  const plan = `# Plan — test\n\n## Goal\n\n${goal}\n\n## In scope\n\n- thing\n`;
  return compilePlanPackFromAccept({
    projectRoot: "/tmp/plan-pack-test-ignored",
    loopId: meta.id,
    version: 1,
    acceptance: {
      version: 1,
      features: [{ id: "goal", label: "Goal", accepted: true }],
    },
    meta,
    plan,
  });
}

describe("plan-pack truncation", () => {
  it("truncates a >500-char goal at a word boundary with an ellipsis", () => {
    const pack = compileGoal(LONG_GOAL);
    assert.ok(pack.goal.length <= 500, "goal exceeds 500 chars");
    assert.ok(pack.goal.endsWith("…"), "truncated goal must end with ellipsis");
    // Boundary-aware truncation stops before the straddling token, so its
    // partial prefix must not appear (straight .slice(0,500) would leave "straddlewo").
    assert.ok(!pack.goal.includes("straddle"), "goal must not end mid-word");
  });

  it("leaves a short goal intact", () => {
    const pack = compileGoal("Make the composer submit reliably.");
    assert.equal(pack.goal, "Make the composer submit reliably.");
  });

  it("phase description keeps the full bounded goal (no 400-char re-cap)", () => {
    const goal = "x".repeat(500);
    const pack = {
      goal,
      focus: "change",
      kind: "feature",
      successCriteria: [],
    } as unknown as PlanPack;
    const desc = phaseDescriptionFromPlanPack(pack);
    assert.ok(desc.includes(goal), "description must contain the full 500-char goal");
    assert.ok(desc.length <= 4000, "description exceeds 4000 chars");
  });
});
