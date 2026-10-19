import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import { agentFinishReason, runAgent, runAgentLiveTurn } from "./index.js";

type GenerateOpts = {
  abortSignal?: AbortSignal;
  modelSettings?: { maxOutputTokens?: number };
};

/** Minimal Agent stub: only the surface runAgent/runAgentLiveTurn touch. */
function stubAgent(opts: {
  generate?: (prompt: string, o: GenerateOpts) => Promise<unknown>;
  stream?: (prompt: string, o: GenerateOpts) => Promise<unknown>;
  maxTokens?: number;
}): Agent {
  return {
    id: "stub",
    name: "Stub Agent",
    model: { defaultParams: { maxTokens: opts.maxTokens ?? 1024 } },
    generate: opts.generate ?? (async () => ({ text: "" })),
    stream: opts.stream ?? (async () => ({ text: "" })),
  } as unknown as Agent;
}

describe("agentFinishReason", () => {
  it("prefers the top-level finishReason, else the last step", () => {
    assert.equal(agentFinishReason({ finishReason: "stop" }), "stop");
    assert.equal(
      agentFinishReason({
        steps: [{ finishReason: "stop" }, { finishReason: "length" }],
      }),
      "length",
    );
    assert.equal(agentFinishReason({}), "");
  });
});

describe("runAgent turn budget", () => {
  it("aborts the generation when the turn times out", async () => {
    let captured: AbortSignal | undefined;
    const agent = stubAgent({
      generate: async (_prompt, o) => {
        captured = o.abortSignal;
        return new Promise((_resolve, reject) => {
          o.abortSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      },
    });
    await assert.rejects(
      () =>
        runAgent(agent, "prompt", "proj", "thread", {
          timeoutMs: 50,
          memory: false,
        }),
      /Agent Stub Agent timed out after 50ms/,
    );
    assert.ok(captured, "abortSignal must be passed to agent.generate");
    assert.equal(captured!.aborted, true, "timeout must abort the request");
  });

  it("retries once with a larger token budget on finishReason=length", async () => {
    const calls: GenerateOpts[] = [];
    const agent = stubAgent({
      generate: async (_prompt, o) => {
        calls.push(o);
        return {
          text: calls.length === 1 ? "" : "second attempt",
          finishReason: calls.length === 1 ? "length" : "stop",
        };
      },
    });
    const text = await runAgent(agent, "prompt", "proj", "thread", {
      memory: false,
    });
    assert.equal(text, "second attempt");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.modelSettings, undefined);
    assert.ok(
      (calls[1]?.modelSettings?.maxOutputTokens ?? 0) > 1024,
      "retry must raise maxOutputTokens",
    );
  });

  it("fails typed when still truncated after the budget retry", async () => {
    let calls = 0;
    const agent = stubAgent({
      generate: async () => {
        calls += 1;
        return { text: "", finishReason: "length" };
      },
    });
    await assert.rejects(
      () => runAgent(agent, "prompt", "proj", "thread", { memory: false }),
      /agent_truncated: Stub Agent exceeded its token budget/,
    );
    assert.equal(calls, 2, "exactly one truncation retry");
  });

  it("does not retry truncation when truncationRetry is false", async () => {
    let calls = 0;
    const agent = stubAgent({
      generate: async () => {
        calls += 1;
        return { text: "partial", finishReason: "length" };
      },
    });
    const text = await runAgent(agent, "prompt", "proj", "thread", {
      memory: false,
      truncationRetry: false,
    });
    assert.equal(text, "partial");
    assert.equal(calls, 1);
  });
});

describe("runAgentLiveTurn turn budget", () => {
  it("aborts the stream when the turn times out", async () => {
    let captured: AbortSignal | undefined;
    const agent = stubAgent({
      stream: async (_prompt, o) => {
        captured = o.abortSignal;
        return new Promise(() => undefined);
      },
    });
    await assert.rejects(
      () =>
        runAgentLiveTurn(agent, "prompt", "proj", "thread", {
          timeoutMs: 50,
        }),
      /Agent Stub Agent timed out after 50ms/,
    );
    assert.ok(captured, "abortSignal must be passed to agent.stream");
    assert.equal(captured!.aborted, true, "timeout must abort the stream");
  });
});
