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

  it("trips on thrash (many tools, little text)", () => {
    const reg = new LiveTurnRegistry();
    const turn = reg.start({
      kind: "ask",
      projectId: "p",
      sessionId: "c",
    });
    for (let i = 0; i < 4; i++) {
      reg.emit(turn.turnId, {
        type: "tool_call",
        tool: `tool_${i}`,
        summary: `tool_${i} args`,
      });
    }
    const reason = evaluateLiveTurnWatch(turn, baseCfg, Date.now());
    assert.equal(reason, "watcher_thrash");
  });
});
