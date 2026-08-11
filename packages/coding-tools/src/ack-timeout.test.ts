import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeAckTimeoutError } from "./opencode-adapter.js";

describe("OpenCodeAckTimeoutError", () => {
  it("keeps the greppable message shape and carries the abort reason", () => {
    const err = new OpenCodeAckTimeoutError("turn_timeout");
    assert.equal(err.name, "OpenCodeAckTimeoutError");
    assert.equal(err.abortReason, "turn_timeout");
    assert.match(err.message, /^OpenCode session ack aborted: turn_timeout$/);
    assert.ok(err instanceof Error);
  });

  it("is distinguishable from generic errors (orchestrator stall path)", () => {
    const generic = new Error("OpenCode session ack aborted: turn_timeout");
    assert.ok(!(generic instanceof OpenCodeAckTimeoutError));
  });
});
