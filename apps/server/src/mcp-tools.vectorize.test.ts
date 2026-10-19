import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SLOPCONTROL_MCP_TOOLS,
  dispatchSlopcontrolTool,
} from "./mcp-tools.js";

describe("vectorize_design_image MCP", () => {
  it("is listed immediately after generate_design_image", () => {
    const names = SLOPCONTROL_MCP_TOOLS.map((tool) => tool.name);
    const index = names.indexOf("generate_design_image");
    assert.ok(index >= 0);
    assert.equal(names[index + 1], "vectorize_design_image");
  });

  it("POSTs to /projects/:id/design-images/vectorize", async () => {
    const original = globalThis.fetch;
    let url = "";
    let method = "";
    let body = "";
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      url = String(input);
      method = init?.method ?? "GET";
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ status: "passed" }), { status: 201 });
    }) as typeof fetch;
    try {
      const result = await dispatchSlopcontrolTool(
        "vectorize_design_image",
        {
          projectId: "proj 1",
          loopId: "loop-1",
          sourceFilename: "mark.png",
        },
        { serverUrl: "http://127.0.0.1:9" },
      );
      assert.equal(method, "POST");
      assert.match(url, /\/projects\/proj%201\/design-images\/vectorize$/);
      assert.match(body, /"sourceFilename":"mark.png"/);
      assert.equal(result.isError, false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
