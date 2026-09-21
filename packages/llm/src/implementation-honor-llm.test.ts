import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IMPLEMENTATION_HONOR_SYSTEM_PROMPT,
  ImplementationHonorResultSchema,
} from "./implementation-honor-llm.js";

describe("implementation-honor-llm", () => {
  it("system prompt frames utility-class approximation as a fidelity failure", () => {
    assert.match(IMPLEMENTATION_HONOR_SYSTEM_PROMPT, /JSON/);
    assert.match(IMPLEMENTATION_HONOR_SYSTEM_PROMPT, /fidelity/);
    assert.match(IMPLEMENTATION_HONOR_SYSTEM_PROMPT, /utility-class soup/i);
    assert.match(IMPLEMENTATION_HONOR_SYSTEM_PROMPT, /missingStyles/);
    assert.match(IMPLEMENTATION_HONOR_SYSTEM_PROMPT, /missingTokens/);
  });

  it("parses honor schema fixtures", () => {
    const high = ImplementationHonorResultSchema.parse({
      fidelity: "high",
      missingStyles: [],
      missingTokens: [],
      notes: "Mock classes ported verbatim into the consumer stylesheet.",
      confidence: "high",
    });
    assert.equal(high.fidelity, "high");
    assert.equal(high.missingStyles.length, 0);

    const low = ImplementationHonorResultSchema.parse({
      fidelity: "low",
      missingStyles: [".env-pane border-left accent", ".secret-row layout"],
      missingTokens: ["--pane-w"],
      notes: "Utility-class approximation; mock component CSS dropped.",
      confidence: "high",
    });
    assert.equal(low.fidelity, "low");
    assert.deepEqual(low.missingTokens, ["--pane-w"]);

    // Defaults: missing arrays default to [], so partial fixtures parse.
    const partial = ImplementationHonorResultSchema.parse({
      fidelity: "partial",
      notes: "Some rules carried; sidebar spacing dropped.",
      confidence: "medium",
    });
    assert.equal(partial.missingStyles.length, 0);
    assert.equal(partial.missingTokens.length, 0);
  });
});
