import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LiveTurnRegistry } from "./live-turns.js";
import {
  evaluateLiveTurnWatch,
  resolveLiveWatcherConfig,
  type LiveWatcherConfig,
} from "./live-turn-watcher.js";

describe("LiveTurnRegistry", () => {
  it("start emit stop aborts signal", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "ask",
      projectId: "p1",
      sessionId: "a1",
    });
    assert.equal(turn.status, "running");
    reg.emit(turn.turnId, {
      type: "tool_call",
      tool: "grep_files",
      summary: "grep @source",
    });
    assert.equal(turn.events.length, 1);
    const stopped = reg.stop("ask", "a1", "operator_stop");
    assert.ok(stopped);
    assert.equal(stopped?.status, "interrupted");
    assert.equal(turn.controller.signal.aborted, true);
    assert.equal(reg.getActive("ask", "a1"), undefined);
  });

  it("supersedes prior running turn for same session", () => {
    const reg = new LiveTurnRegistry();
    const first = reg.start({
      kind: "agent",
      projectId: "p1",
      sessionId: "ag1",
    });
    const second = reg.start({
      kind: "agent",
      projectId: "p1",
      sessionId: "ag1",
    });
    assert.equal(first.status, "interrupted");
    assert.equal(first.interruptReason, "superseded");
    assert.equal(second.status, "running");
    assert.equal(reg.getActive("agent", "ag1")?.turnId, second.turnId);
  });
});

describe("live-turn watcher heuristics", () => {
  const baseCfg: LiveWatcherConfig = {
    ...resolveLiveWatcherConfig(),
    enabled: true,
    stallMs: 1_000,
    repeatToolLimit: 3,
    thrashToolLimit: 4,
    maxAgeMs: 60_000,
    pollMs: 1_000,
  };

  it("trips on repeat tool fingerprint", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "ask",
      projectId: "p",
      sessionId: "a",
    });
    for (let i = 0; i < 3; i++) {
      reg.emit(turn.turnId, {
        type: "tool_call",
        tool: "grep_files",
        summary: "grep_files path=playground pattern=@source",
      });
    }
    const reason = evaluateLiveTurnWatch(turn, baseCfg, Date.now());
    assert.equal(reason, "watcher_repeat_tool");
  });

  it("trips on stall", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "ask",
      projectId: "p",
      sessionId: "b",
    });
    turn.lastEventAt = new Date(Date.now() - 5_000).toISOString();
    const reason = evaluateLiveTurnWatch(turn, baseCfg, Date.now());
    assert.equal(reason, "watcher_stall");
  });

  it("trips on thrash (many calls, low diversity, no text)", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "ask",
      projectId: "p",
      sessionId: "c",
    });
    // 4 calls across 2 fingerprints (2x each — under repeatToolLimit 3).
    for (let i = 0; i < 4; i++) {
      reg.emit(turn.turnId, {
        type: "tool_call",
        tool: "read_file",
        summary: `read_file path=src/${i % 2}.ts`,
      });
    }
    const reason = evaluateLiveTurnWatch(turn, baseCfg, Date.now());
    assert.equal(reason, "watcher_thrash");
  });

  it("does NOT trip on diverse read-heavy exploration (the plan-loop case)", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "ask",
      projectId: "p",
      sessionId: "explore",
    });
    // 16 distinct reads, no narration — legitimate exploration.
    for (let i = 0; i < 16; i++) {
      reg.emit(turn.turnId, {
        type: "tool_call",
        tool: "read_file",
        summary: `read_file path=src/module-${i}.ts`,
      });
    }
    const reason = evaluateLiveTurnWatch(turn, baseCfg, Date.now());
    assert.equal(reason, null);
  });

  it("plan_loop gets its own thrash budget (distinct reads under 40)", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "plan_loop",
      projectId: "p",
      sessionId: "pl",
    });
    // Identical low-diversity loop on plan_loop trips (kind budget exceeded
    // only when volume passes 40 — here diversity gate alone must hold).
    for (let i = 0; i < 16; i++) {
      reg.emit(turn.turnId, {
        type: "tool_call",
        tool: "grep_files",
        summary: `grep_files pattern=q${i}`,
      });
    }
    assert.equal(evaluateLiveTurnWatch(turn, baseCfg, Date.now()), null);

    // But a plan_loop turn repeating a couple of calls IS thrash once the
    // kind budget (2 here) is exceeded.
    const tightCfg: LiveWatcherConfig = {
      ...baseCfg,
      thrashToolLimitByKind: { plan_loop: 4 },
    };
    const reg2 = new LiveTurnRegistry();
    const t2 = reg2.start({
      kind: "plan_loop",
      projectId: "p",
      sessionId: "pl2",
    });
    for (let i = 0; i < 4; i++) {
      reg2.emit(t2.turnId, {
        type: "tool_call",
        tool: "read_file",
        summary: `read_file path=src/${i % 2}.ts`,
      });
    }
    assert.equal(evaluateLiveTurnWatch(t2, tightCfg, Date.now()), "watcher_thrash");
  });

  it("resolveLiveWatcherConfig defaults plan_loop thrash budget to 40", () => {
    const cfg = resolveLiveWatcherConfig();
    assert.equal(cfg.thrashToolLimitByKind.plan_loop, 40);
  });

  it("textLen survives event eviction (no thrash after early narration)", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "ask",
      projectId: "p",
      sessionId: "evict",
    });
    reg.emit(turn.turnId, { type: "text", text: "x".repeat(100) });
    // Flood with status events to evict the text from the ring buffer.
    for (let i = 0; i < 210; i++) {
      reg.emit(turn.turnId, { type: "status", summary: `step ${i}` });
    }
    assert.equal(turn.events.some((e) => e.type === "text"), false);
    assert.equal(turn.textLen, 100);
    // Low-diversity tool burst post-eviction: text still counts → no thrash.
    for (let i = 0; i < 4; i++) {
      reg.emit(turn.turnId, {
        type: "tool_call",
        tool: "read_file",
        summary: `read_file path=src/${i % 2}.ts`,
      });
    }
    assert.equal(evaluateLiveTurnWatch(turn, baseCfg, Date.now()), null);
  });
});
