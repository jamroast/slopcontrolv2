import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchSlopcontrolTool,
  SLOPCONTROL_MCP_TOOLS,
} from "./mcp-tools.js";

const CHAT_TOOLS = [
  "chat_start",
  "chat_list",
  "chat_get",
  "chat_send",
  "chat_confirm",
  "chat_close",
  "chat_delete",
  "chat_models_list",
  "chat_model_set",
  "chat_function_bind",
] as const;

describe("chat MCP tool registry", () => {
  it("registers every chat_* tool from the plan", () => {
    const names = new Set(SLOPCONTROL_MCP_TOOLS.map((t) => t.name));
    for (const name of CHAT_TOOLS) {
      assert.ok(names.has(name), `missing MCP tool ${name}`);
    }
  });

  it("chat_function_bind requires function and modelId", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "chat_function_bind");
    assert.ok(tool);
    assert.deepEqual(
      (tool.inputSchema as { required?: string[] }).required,
      ["function", "modelId"],
    );
  });

  it("registers project_set_ask_investigate_tool", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find(
      (t) => t.name === "project_set_ask_investigate_tool",
    );
    assert.ok(tool);
    assert.deepEqual(
      (tool.inputSchema as { required?: string[] }).required,
      ["projectId", "tool"],
    );
  });

  it("does not register chat_endpoint_model_update", () => {
    const names = new Set(SLOPCONTROL_MCP_TOOLS.map((t) => t.name));
    assert.equal(names.has("chat_endpoint_model_update"), false);
  });

  it("registers submit_review with runId and decision", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "submit_review");
    assert.ok(tool);
    assert.deepEqual(
      (tool.inputSchema as { required?: string[] }).required,
      ["runId", "decision"],
    );
  });

  it("registers advance_run with runId", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "advance_run");
    assert.ok(tool);
    assert.deepEqual(
      (tool.inputSchema as { required?: string[] }).required,
      ["runId"],
    );
  });

  it("chat_get requires conversationId", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "chat_get");
    assert.ok(tool);
    assert.deepEqual(
      (tool.inputSchema as { required?: string[] }).required,
      ["conversationId"],
    );
  });

  it("dispatchSlopcontrolTool rejects unknown tools", async () => {
    const result = await dispatchSlopcontrolTool("not_a_real_slopcontrol_tool", {});
    assert.equal(result.isError, true);
    assert.ok(
      result.content[0]?.text.includes("Unknown tool"),
      result.content[0]?.text,
    );
  });
});
