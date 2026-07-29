import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DevelopLock } from "./develop-lock.js";

describe("DevelopLock", () => {
  it("blocks a second claim while the first run is active", () => {
    const active = new Set<string>(["run-a"]);
    const lock = new DevelopLock((id) => active.has(id));

    assert.deepEqual(lock.tryClaim("proj-1", "run-a"), { ok: true });
    const second = lock.tryClaim("proj-1", "run-b");
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.blockingRunId, "run-a");
  });

  it("allows another project concurrently", () => {
    const active = new Set<string>(["run-a", "run-c"]);
    const lock = new DevelopLock((id) => active.has(id));
    assert.equal(lock.tryClaim("proj-1", "run-a").ok, true);
    assert.equal(lock.tryClaim("proj-2", "run-c").ok, true);
  });

  it("allows a new claim after release", () => {
    const active = new Set<string>(["run-a"]);
    const lock = new DevelopLock((id) => active.has(id));
    assert.equal(lock.tryClaim("proj-1", "run-a").ok, true);
    lock.release("proj-1", "run-a");
    active.delete("run-a");
    active.add("run-b");
    assert.equal(lock.tryClaim("proj-1", "run-b").ok, true);
  });

  it("clears stale claim when run is no longer active (failed/orphan)", () => {
    const active = new Set<string>(["run-a"]);
    const lock = new DevelopLock((id) => active.has(id));
    assert.equal(lock.tryClaim("proj-1", "run-a").ok, true);
    active.delete("run-a"); // simulate job finished/failed without release
    // getLiveClaim / tryClaim should treat as free
    assert.equal(lock.getLiveClaim("proj-1"), undefined);
    active.add("run-b");
    assert.equal(lock.tryClaim("proj-1", "run-b").ok, true);
  });

  it("clearProject drops the claim", () => {
    const active = new Set<string>(["run-a"]);
    const lock = new DevelopLock((id) => active.has(id));
    assert.equal(lock.tryClaim("proj-1", "run-a").ok, true);
    lock.clearProject("proj-1");
    assert.equal(lock.tryClaim("proj-1", "run-b").ok, true);
  });
});
