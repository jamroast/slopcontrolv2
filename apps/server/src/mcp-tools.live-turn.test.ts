import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  consumeLiveTurnSseBounded,
  formatDesignLoopMcpEnvelope,
  formatMarketingLoopMcpEnvelope,
  formatPlanLoopMcpEnvelope,
  formatRunningTurnEnvelope,
  resolveMcpWaitMs,
  runLoopTurnTool,
} from "./mcp-tools.js";

function openSse(
  initial = "",
  opts: { close?: boolean } = {},
): {
  body: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial) controller.enqueue(new TextEncoder().encode(initial));
      if (opts.close !== false) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveMcpWaitMs", () => {
  it("clamps to the bounded MCP window", () => {
    assert.equal(resolveMcpWaitMs(undefined), 20_000);
    assert.equal(resolveMcpWaitMs(5), 1_000);
    assert.equal(resolveMcpWaitMs(600_000), 45_000);
    assert.equal(resolveMcpWaitMs(Number.NaN), 20_000);
  });
});

describe("consumeLiveTurnSseBounded", () => {
  it("returns the terminal done event when the turn settles in time", async () => {
    const { body } = openSse(
      'data: {"type":"status","summary":"turn started","turnId":"t1"}\n\n' +
        'data: {"type":"done","loopId":"l1","version":2}\n\n',
    );
    // Close so the reader drains.
    const result = await consumeLiveTurnSseBounded({
      logger: "plan_loop",
      body,
      waitMs: 1_000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, undefined);
    assert.equal(result.turnId, "t1");
    assert.equal(result.done?.version, 2);
  });

  it("returns a resumable running result instead of blocking past the wait", async () => {
    const { body, cancelled } = openSse(
      'data: {"type":"status","summary":"turn started","turnId":"t2"}\n\n' +
        'data: {"type":"tool_call","tool":"grep_files","summary":"grep src"}\n\n',
      { close: false },
    );
    const started = Date.now();
    const result = await consumeLiveTurnSseBounded({
      logger: "plan_loop",
      body,
      waitMs: 40,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 900, `expected bounded wait, took ${elapsed}ms`);
    assert.equal(result.ok, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.turnId, "t2");
    assert.ok(cancelled(), "client stream should be cancelled after the wait");
    assert.ok(result.progress.some((line) => line.includes("grep")));
  });
});

describe("formatRunningTurnEnvelope", () => {
  it("is a non-error, resumable envelope with the next step", () => {
    const text = formatRunningTurnEnvelope({
      kind: "plan_loop",
      loopId: "l1",
      turnId: "t1",
      waitedMs: 20_000,
      progress: ["tool_call: grep src"],
      getTool: "plan_loop_get",
    });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(parsed.status, "running");
    assert.equal(parsed.turnId, "t1");
    assert.match(String(parsed.nextStep), /wait_for_live_turn/);
    assert.match(String(parsed.nextStep), /plan_loop_get/);
    assert.match(String(parsed.nextStep), /Do not start or continue/);
  });
});

describe("runLoopTurnTool", () => {
  const format = (body: string, ok: boolean) => (ok ? body : `ERR:${body}`);

  it("attaches to an already-running turn without starting another", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      assert.match(url, /\/live-turns\?/);
      return new Response(
        JSON.stringify({
          running: true,
          liveTurn: { turnId: "t-running", status: "running" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await runLoopTurnTool({
      serverUrl: "http://localhost:1",
      kind: "plan_loop",
      logger: "plan_loop",
      projectId: "p1",
      sessionId: "l1",
      postUrl: "http://localhost:1/projects/p1/plan-loops/l1/continue?stream=1",
      payload: { message: "tweak" },
      waitMs: 50,
      getTool: "plan_loop_get",
      format,
    });

    assert.equal(calls.length, 1, "must not POST a second generation");
    assert.equal(result.isError, false);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.status, "running");
    assert.equal(parsed.turnId, "t-running");
  });

  it("attaches a retried start to the project's running turn (no second loop)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({
          running: true,
          liveTurn: { turnId: "t9", sessionId: "l9", status: "running" },
          turns: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await runLoopTurnTool({
      serverUrl: "http://localhost:1",
      kind: "plan_loop",
      logger: "plan_loop",
      projectId: "p1",
      sessionId: "",
      postUrl: "http://localhost:1/projects/p1/plan-loops?stream=1",
      payload: { brief: "plan it" },
      waitMs: 50,
      getTool: "plan_loop_get",
      format,
    });

    assert.equal(calls.length, 1, "must not create another plan loop");
    assert.doesNotMatch(calls[0] ?? "", /sessionId=/);
    assert.equal(result.isError, false);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.loopId, "l9");
    assert.equal(parsed.turnId, "t9");
  });

  it("returns a running envelope (not an error) when the bounded wait expires", async () => {
    const posts: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/live-turns?")) {
        return new Response(JSON.stringify({ running: false, liveTurn: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      posts.push(`${url} ${String(init?.method)}`);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"status","summary":"turn started","turnId":"t3"}\n\n',
            ),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const result = await runLoopTurnTool({
      serverUrl: "http://localhost:1",
      kind: "plan_loop",
      logger: "plan_loop",
      projectId: "p1",
      sessionId: "l1",
      postUrl: "http://localhost:1/projects/p1/plan-loops/l1/continue?stream=1",
      payload: { message: "tweak" },
      waitMs: 40,
      getTool: "plan_loop_get",
      format,
    });

    assert.equal(posts.length, 1);
    assert.match(posts[0] ?? "", /attachIfRunning=1/);
    assert.equal(result.isError, false);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.status, "running");
    assert.equal(parsed.turnId, "t3");
  });
});

describe("running envelopes in loop formatters", () => {
  const body = JSON.stringify({
    status: "running",
    kind: "plan_loop",
    loopId: "l1",
    turnId: "t1",
    waitedMs: 20_000,
    progress: ["tool_call: grep src"],
    nextStep: "call wait_for_live_turn with turnId=t1",
  });

  it("renders the running envelope as status, not an error", () => {
    for (const format of [
      formatPlanLoopMcpEnvelope,
      formatMarketingLoopMcpEnvelope,
      formatDesignLoopMcpEnvelope,
    ]) {
      const out = format(body, true);
      assert.match(out, /status: running/);
      assert.match(out, /turnId: t1/);
      assert.match(out, /progress:\n  - tool_call: grep src/);
      assert.match(out, /nextStep: call wait_for_live_turn with turnId=t1/);
      assert.doesNotMatch(out, /^error:/m);
    }
  });

  it("loop get envelopes surface the live turn line", () => {
    const out = formatPlanLoopMcpEnvelope(
      JSON.stringify({
        loopId: "l1",
        version: 1,
        plan: "x",
        liveTurn: { status: "running", turnId: "t1", elapsedMs: 42 },
      }),
      true,
    );
    assert.match(out, /liveTurn: running turnId=t1 elapsedMs=42/);
  });
});
