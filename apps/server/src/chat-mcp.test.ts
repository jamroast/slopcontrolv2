import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
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
  "chat_reopen",
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

  it("chat_reopen requires conversationId", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "chat_reopen");
    assert.ok(tool);
    assert.deepEqual(
      (tool.inputSchema as { required?: string[] }).required,
      ["conversationId"],
    );
  });

  it("chat_reopen POSTs /chats/:id/reopen", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ({
      ok: true,
      text: async () => '{"conversation":{"id":"c1","status":"active"}}',
    }));
    try {
      const result = await dispatchSlopcontrolTool("chat_reopen", {
        conversationId: "c1",
      });
      assert.equal(result.isError, false);
      assert.match(result.content[0]?.text ?? "", /"status":"active"/);
      const [url, init] = fetchMock.mock.calls[0]?.arguments ?? [];
      assert.match(String(url), /\/chats\/c1\/reopen$/);
      assert.equal((init as RequestInit)?.method, "POST");
    } finally {
      fetchMock.mock.restore();
    }
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

describe("awaited-run + run-status MCP tools", () => {
  it("registers all three with the right required params", () => {
    const byName = new Map(SLOPCONTROL_MCP_TOOLS.map((t) => [t.name, t]));
    for (const name of [
      "chat_get_awaited_run",
      "chat_list_awaited_runs",
      "chat_get_run_status",
    ]) {
      assert.ok(byName.has(name), `missing MCP tool ${name}`);
    }
    assert.deepEqual(
      (byName.get("chat_get_awaited_run")?.inputSchema as { required?: string[] })
        .required,
      ["conversationId"],
    );
    assert.deepEqual(
      (byName.get("chat_get_run_status")?.inputSchema as { required?: string[] })
        .required,
      ["runId"],
    );
    assert.equal(
      (byName.get("chat_list_awaited_runs")?.inputSchema as { required?: string[] })
        .required,
      undefined,
    );
  });

  function mockFetch(body: string, ok = true) {
    return mock.method(globalThis, "fetch", async () => ({
      ok,
      text: async () => body,
    }));
  }

  it("chat_get_awaited_run GETs /chats/:id/awaited-runs", async () => {
    const fetchMock = mockFetch('{"awaited":null}');
    try {
      const result = await dispatchSlopcontrolTool("chat_get_awaited_run", {
        conversationId: "conv 1",
      });
      assert.equal(result.isError, false);
      assert.equal(result.content[0]?.text, '{"awaited":null}');
      const url = String(fetchMock.mock.calls[0]?.arguments[0]);
      assert.match(url, /\/chats\/conv%201\/awaited-runs$/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("chat_list_awaited_runs GETs /chats/awaited-runs", async () => {
    const fetchMock = mockFetch('{"awaited":[]}');
    try {
      const result = await dispatchSlopcontrolTool("chat_list_awaited_runs", {});
      assert.equal(result.isError, false);
      const url = String(fetchMock.mock.calls[0]?.arguments[0]);
      assert.match(url, /\/chats\/awaited-runs$/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("chat_get_run_status GETs /runs/:id/status and surfaces HTTP errors", async () => {
    const fetchMock = mockFetch('{"stage":"developing","stageKind":"busy"}');
    try {
      const result = await dispatchSlopcontrolTool("chat_get_run_status", {
        runId: "run 1",
      });
      assert.equal(result.isError, false);
      const url = String(fetchMock.mock.calls[0]?.arguments[0]);
      assert.match(url, /\/runs\/run%201\/status$/);
    } finally {
      fetchMock.mock.restore();
    }

    const failing = mockFetch("not found", false);
    try {
      const result = await dispatchSlopcontrolTool("chat_get_run_status", {
        runId: "run-x",
      });
      assert.equal(result.isError, true);
      assert.equal(result.content[0]?.text, "not found");
    } finally {
      failing.mock.restore();
    }
  });
});
