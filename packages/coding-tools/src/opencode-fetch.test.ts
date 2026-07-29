import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureOpenCodeFetchTimeouts,
  getOpenCodeFetchTimeoutMsForTests,
  resetOpenCodeFetchTimeoutsForTests,
} from "./opencode-fetch.js";

describe("ensureOpenCodeFetchTimeouts", () => {
  it("is idempotent and records timeout ms", () => {
    resetOpenCodeFetchTimeoutsForTests();
    const prev = process.env.SLOPCONTROL_OPENCODE_FETCH_MS;
    process.env.SLOPCONTROL_OPENCODE_FETCH_MS = "123456";
    try {
      ensureOpenCodeFetchTimeouts();
      assert.equal(getOpenCodeFetchTimeoutMsForTests(), 123456);
      ensureOpenCodeFetchTimeouts();
      assert.equal(getOpenCodeFetchTimeoutMsForTests(), 123456);
    } finally {
      if (prev === undefined) delete process.env.SLOPCONTROL_OPENCODE_FETCH_MS;
      else process.env.SLOPCONTROL_OPENCODE_FETCH_MS = prev;
      resetOpenCodeFetchTimeoutsForTests();
    }
  });

  it("keeps globalThis.fetch Request-compatible after install", async () => {
    resetOpenCodeFetchTimeoutsForTests();
    ensureOpenCodeFetchTimeouts();
    // Must not throw "Failed to parse URL from [object Request]"
    const res = await fetch(new Request("https://example.com/"));
    assert.equal(res.ok || res.status > 0, true);
  });
});
