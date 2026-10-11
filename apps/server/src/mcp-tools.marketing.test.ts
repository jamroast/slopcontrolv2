import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMarketingLoopMcpEnvelope } from "./mcp-tools.js";

describe("formatMarketingLoopMcpEnvelope", () => {
  it("emits a doc_slice continuation when the doc is paged", () => {
    const body = JSON.stringify({
      loopId: "loop-1",
      loop: { status: "open" },
      version: 1,
      doc: "# Marketing\nchunk",
      docTotalChars: 20_000,
      docOffset: 0,
      verdict: { ok: false, gaps: ["No source"] },
      nextStep: "marketing_loop_continue",
    });
    const out = formatMarketingLoopMcpEnvelope(body, true);
    assert.match(out, /loopId: loop-1/);
    assert.match(out, /verdict: ok=false gaps=1/);
    assert.match(
      out,
      /doc_slice: chars 0\.\.\d+ of 20000 — call marketing_loop_get with offset \d+/,
    );
  });

  it("omits the slice hint when the whole doc fit", () => {
    const doc = "# Marketing\nshort";
    const body = JSON.stringify({
      loopId: "loop-1",
      doc,
      docTotalChars: doc.length,
      docOffset: 0,
    });
    const out = formatMarketingLoopMcpEnvelope(body, true);
    assert.equal(out.includes("doc_slice:"), false);
  });
});
