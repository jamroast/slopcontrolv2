import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SLOPCONTROL_MCP_TOOLS } from "./mcp-tools.js";

describe("MCP verify-steps tools", () => {
  it("registers get_run_steps and retry_verify schemas", () => {
    const names = new Set(SLOPCONTROL_MCP_TOOLS.map((t) => t.name));
    assert.ok(names.has("get_run_steps"));
    assert.ok(names.has("retry_verify"));
    assert.ok(names.has("get_run"));
    assert.ok(names.has("wait_for_run"));
    assert.ok(names.has("retry_development"));

    const steps = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "get_run_steps");
    assert.ok(steps);
    assert.deepEqual(
      (steps!.inputSchema as { required?: string[] }).required,
      ["runId"],
    );

    const retry = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "retry_verify");
    assert.ok(retry);
    assert.match(retry!.description ?? "", /no coding/i);
    assert.deepEqual(
      (retry!.inputSchema as { required?: string[] }).required,
      ["runId"],
    );

    const getRun = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "get_run");
    assert.match(getRun!.description ?? "", /verify_steps/);
  });
});

describe("MCP relaunch_design_research", () => {
  it("registers relaunch_design_research schema", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find(
      (t) => t.name === "relaunch_design_research",
    );
    assert.ok(tool);
    assert.match(tool!.description ?? "", /recovery|research/i);
    assert.deepEqual(
      (tool!.inputSchema as { required?: string[] }).required,
      ["projectId"],
    );
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    assert.ok(props?.loopId);
    assert.ok(props?.phaseId);
  });
});
