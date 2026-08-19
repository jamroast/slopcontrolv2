import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirtyDelta } from "./dirty-delta.js";

describe("dirtyDelta", () => {
  it("returns only paths absent from the baseline", () => {
    const baseline = new Set(["src/app.ts", "node_modules/x/index.js"]);
    const current = ["src/app.ts", "node_modules/x/index.js", "src/evil.ts"];
    assert.deepEqual(dirtyDelta(baseline, current), ["src/evil.ts"]);
  });

  it("returns empty when nothing changed after baseline", () => {
    const baseline = new Set(["a.ts", "b.ts"]);
    assert.deepEqual(dirtyDelta(baseline, ["a.ts", "b.ts"]), []);
  });

  it("degrades to full list when baseline is null (capture failed)", () => {
    assert.deepEqual(dirtyDelta(null, ["a.ts"]), ["a.ts"]);
  });

  it("handles a path removed from the tree (absent from current)", () => {
    const baseline = new Set(["gone.ts", "kept.ts"]);
    assert.deepEqual(dirtyDelta(baseline, ["kept.ts"]), []);
  });
});
