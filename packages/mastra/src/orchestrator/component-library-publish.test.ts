import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeLibraryPublishResponse } from "./index.js";

describe("summarizeLibraryPublishResponse", () => {
  it("success with consumers counts updates", () => {
    const out = summarizeLibraryPublishResponse(200, {
      name: "@jamroast/components",
      version: "0.0.1",
      propagation: [{ ok: true }, { ok: false }],
    });
    assert.equal(out.ok, true);
    assert.match(out.summary, /@jamroast\/components@0\.0\.1 published/);
    assert.match(out.summary, /1\/2 consumers updated/);
  });

  it("success without consumers says so", () => {
    const out = summarizeLibraryPublishResponse(200, {
      name: "@jamroast/components",
      version: "0.0.1",
    });
    assert.equal(out.ok, true);
    assert.match(out.summary, /no registered consumers/);
  });

  it("HTTP failure surfaces the server error (phase must stay complete)", () => {
    const out = summarizeLibraryPublishResponse(400, {
      error: "version bump failed (1): boom",
    });
    assert.equal(out.ok, false);
    assert.match(out.summary, /version bump failed/);
  });

  it("HTTP failure without body error falls back to status", () => {
    const out = summarizeLibraryPublishResponse(500, {});
    assert.equal(out.ok, false);
    assert.match(out.summary, /HTTP 500/);
  });
});
