import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProductiveTurnTimeout,
  isStallAbortReason,
  shouldRecreateCodingSession,
  TURN_BUDGET_YIELD,
} from "./provider-stall.js";
import {
  baseUrlForProject,
  clearCodingEngineAdapterCache,
  getCodingToolForProject,
  portForProject,
  resolveCodingEngineMode,
} from "./coding-engine-supervisor.js";

describe("sticky coding session / soft budget", () => {
  it("treats turn_budget_yield with files as productive", () => {
    assert.equal(
      isProductiveTurnTimeout(TURN_BUDGET_YIELD, ["src/a.ts"]),
      true,
    );
    assert.equal(isStallAbortReason(TURN_BUDGET_YIELD), false);
    assert.equal(
      shouldRecreateCodingSession(TURN_BUDGET_YIELD, ["src/a.ts"]),
      false,
    );
  });

  it("keeps sticky session on idle and rate_limit", () => {
    assert.equal(shouldRecreateCodingSession("turn_idle", []), false);
    assert.equal(
      shouldRecreateCodingSession("provider_rate_limit", ["x"]),
      false,
    );
  });

  it("recreates on empty turn_timeout or probe-like reasons", () => {
    assert.equal(shouldRecreateCodingSession("turn_timeout", []), true);
    assert.equal(
      shouldRecreateCodingSession("turn_timeout", ["src/a.ts"]),
      false,
    );
    assert.equal(
      shouldRecreateCodingSession("probe abuse: curl cloud", []),
      true,
    );
  });
});

describe("coding engine supervisor", () => {
  it("defaults to per_project mode", () => {
    assert.equal(resolveCodingEngineMode({}), "per_project");
    assert.equal(
      resolveCodingEngineMode({ SLOPCONTROL_CODING_MODE: "shared" }),
      "shared",
    );
  });

  it("allocates stable ports per project", () => {
    const a = portForProject("proj-aaa");
    const b = portForProject("proj-aaa");
    const c = portForProject("proj-bbb");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a >= 4100 && a < 4200);
    assert.match(baseUrlForProject("proj-aaa"), /127\.0\.0\.1:\d+/);
  });

  it("returns distinct adapters for different projects in per_project mode", () => {
    clearCodingEngineAdapterCache();
    const t1 = getCodingToolForProject({
      toolId: "opencode",
      projectId: "p1",
      mode: "per_project",
    });
    const t2 = getCodingToolForProject({
      toolId: "opencode",
      projectId: "p2",
      mode: "per_project",
    });
    const t1b = getCodingToolForProject({
      toolId: "opencode",
      projectId: "p1",
      mode: "per_project",
    });
    assert.equal(t1, t1b);
    assert.notEqual(t1, t2);
    assert.equal(
      (t1 as { getBaseUrl?: () => string }).getBaseUrl?.(),
      baseUrlForProject("p1"),
    );
  });

  it("shared mode uses default OpenCode port", () => {
    clearCodingEngineAdapterCache();
    const t = getCodingToolForProject({
      toolId: "opencode",
      projectId: "p1",
      mode: "shared",
    });
    assert.match(
      (t as { getBaseUrl?: () => string }).getBaseUrl?.() ?? "",
      /:4096$/,
    );
  });

  it("defaults to the pi adapter (in-process, no daemon)", () => {
    clearCodingEngineAdapterCache();
    const t = getCodingToolForProject({ projectId: "p1" });
    assert.equal(t.id, "pi");
  });
});
