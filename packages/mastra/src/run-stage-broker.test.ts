import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RunStageBroker, type RunStageEvent } from "./run-stage-broker.js";

function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), "slop-events-"));
}

describe("RunStageBroker persistence", () => {
  it("persists every emit to the JSONL log with monotonic seq", () => {
    const dir = makeLogDir();
    try {
      const logPath = join(dir, "events.jsonl");
      const broker = new RunStageBroker({ logPath });
      broker.emit({ id: "run-1", stage: "researching" });
      broker.emit({ id: "run-1", stage: "in_review", previousStage: "researching" });
      broker.emit({ id: "run-2", stage: "developing", projectId: "p1" });

      const lines = readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim());
      assert.equal(lines.length, 3);
      const events = lines.map((l) => JSON.parse(l) as RunStageEvent);
      assert.deepEqual(
        events.map((e) => e.seq),
        [1, 2, 3],
      );
      assert.equal(events[0]?.type, "run_stage");
      assert.equal(events[1]?.previousStage, "researching");
      assert.equal(events[2]?.projectId, "p1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers seq from the last log line on restart", () => {
    const dir = makeLogDir();
    try {
      const logPath = join(dir, "events.jsonl");
      const first = new RunStageBroker({ logPath });
      first.emit({ id: "run-1", stage: "researching" });
      first.emit({ id: "run-1", stage: "complete", previousStage: "developing" });

      const second = new RunStageBroker({ logPath });
      assert.equal(second.currentSeq(), 2);
      second.emit({ id: "run-2", stage: "developing" });
      assert.equal(second.currentSeq(), 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaySince returns only newer events in order", () => {
    const dir = makeLogDir();
    try {
      const logPath = join(dir, "events.jsonl");
      const broker = new RunStageBroker({ logPath });
      for (let i = 0; i < 5; i++) {
        broker.emit({ id: `run-${i}`, stage: "developing" });
      }
      const replayed = broker.replaySince(2);
      assert.deepEqual(
        replayed.map((e) => e.seq),
        [3, 4, 5],
      );
      assert.equal(broker.replaySince(5).length, 0);
      assert.equal(broker.replaySince(0).length, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("in-process subscribe still fires when persistence is enabled", () => {
    const dir = makeLogDir();
    try {
      const broker = new RunStageBroker({
        logPath: join(dir, "events.jsonl"),
      });
      const seen: string[] = [];
      const unsub = broker.subscribe("run-1", (u) => seen.push(u.stage));
      broker.emit({ id: "run-1", stage: "developing" });
      broker.emit({ id: "run-2", stage: "developing" });
      assert.deepEqual(seen, ["developing"]);
      unsub();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("broker without logPath behaves as before (no file written)", () => {
    const broker = new RunStageBroker();
    broker.emit({ id: "run-1", stage: "developing" });
    assert.equal(broker.currentSeq(), 0);
    assert.equal(broker.replaySince(0).length, 0);
  });

  it("compact keeps latest-per-run and bounds the file", () => {
    const dir = makeLogDir();
    try {
      const logPath = join(dir, "events.jsonl");
      const broker = new RunStageBroker({ logPath });
      // Many events across few runs — compaction should collapse to latest per run
      for (let i = 0; i < 50; i++) {
        broker.emit({ id: `run-${i % 3}`, stage: "developing" });
      }
      assert.equal(broker.replaySince(0).length, 50);

      const compacted = broker.compact(10);
      assert.equal(compacted, true);
      const kept = broker.replaySince(0);
      assert.ok(kept.length <= 10);
      // Latest event per run must survive
      const byRun = new Map(kept.map((e) => [e.id, e]));
      assert.ok(byRun.has("run-0"));
      assert.ok(byRun.has("run-1"));
      assert.ok(byRun.has("run-2"));
      // seq ordering preserved
      const seqs = kept.map((e) => e.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compact is a no-op for small logs", () => {
    const dir = makeLogDir();
    try {
      const logPath = join(dir, "events.jsonl");
      const broker = new RunStageBroker({ logPath });
      broker.emit({ id: "run-1", stage: "developing" });
      assert.equal(broker.compact(), false);
      assert.equal(broker.replaySince(0).length, 1);
      assert.ok(statSync(logPath).size > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
