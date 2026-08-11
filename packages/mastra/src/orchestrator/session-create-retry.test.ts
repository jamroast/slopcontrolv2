import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenCodeAckTimeoutError } from "@slopcontrol/coding-tools";
import { withSessionCreateRetry } from "./index.js";

describe("withSessionCreateRetry", () => {
  it("survives a one-shot ack stall and returns the fresh session", async () => {
    let calls = 0;
    const stalls: number[] = [];
    const session = await withSessionCreateRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new OpenCodeAckTimeoutError("turn_timeout");
        return { id: "session-2" };
      },
      { onStall: (_err, attempt) => stalls.push(attempt) },
    );
    assert.deepEqual(session, { id: "session-2" });
    assert.equal(calls, 2);
    assert.deepEqual(stalls, [1]);
  });

  it("returns null after maxStalls so the run ends blocked, not failed", async () => {
    let calls = 0;
    const session = await withSessionCreateRetry(
      async () => {
        calls += 1;
        throw new OpenCodeAckTimeoutError("turn_timeout");
      },
      { maxStalls: 3 },
    );
    assert.equal(session, null);
    assert.equal(calls, 4); // initial + 3 stall retries
  });

  it("rethrows non-ack errors immediately", async () => {
    let calls = 0;
    await assert.rejects(
      withSessionCreateRetry(async () => {
        calls += 1;
        throw new Error("spawn opencode ENOENT");
      }),
      /ENOENT/,
    );
    assert.equal(calls, 1);
  });
});
