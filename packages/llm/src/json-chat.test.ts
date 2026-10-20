import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import {
  CHAT_JSON_DEFAULT_TIMEOUT_MS,
  CHAT_JSON_SERVER_RETRY_MAX_MS,
  extractChatMessageText,
  isChatJsonTimeoutError,
  isRetryableChatJsonError,
  isServerSideChatJsonError,
  serverRetryDelayMs,
  stripJsonFence,
  chatJson,
} from "./json-chat.js";
import type { LlmEndpoint } from "@slopcontrol/types";
import { z } from "zod";

describe("json-chat helpers", () => {
  it("stripJsonFence unwraps markdown fences", () => {
    assert.equal(
      stripJsonFence('```json\n{"a":1}\n```'),
      '{"a":1}',
    );
    assert.equal(stripJsonFence('noise {"a":1} trailing'), '{"a":1}');
    assert.equal(
      stripJsonFence('```json\n{"ok":true,"gaps":[]}\n'),
      '{"ok":true,"gaps":[]}',
    );
  });

  it("stripJsonFence drops trailing prose even when it contains a brace", () => {
    // The glm-5.2 host-verify-env failure: valid JSON followed by prose with a `}`.
    assert.equal(
      stripJsonFence('{"rewrites":[{"key":"DATABASE_URL","original":"postgresql://x","rewritten":"localhost:5432"}]} trailing } note'),
      '{"rewrites":[{"key":"DATABASE_URL","original":"postgresql://x","rewritten":"localhost:5432"}]}',
    );
  });

  it("stripJsonFence keeps braces inside string values", () => {
    assert.equal(
      stripJsonFence('{"a":"{not a brace}","b":{"c":"}"}} trailing'),
      '{"a":"{not a brace}","b":{"c":"}"}}',
    );
  });

  it("stripJsonFence handles escaped quotes in string values", () => {
    assert.equal(
      stripJsonFence('{"a":"escaped \\" quote"} trailing'),
      '{"a":"escaped \\" quote"}',
    );
  });

  it("stripJsonFence finds JSON after a prose preamble (glm-5.3 shape)", () => {
    assert.equal(
      stripJsonFence(
        'Let me analyze this PHASE.md draft against the RESEARCH.md and Change Intent.\n\nThe draft is good.\n\n{"ok":true,"gaps":[]}',
      ),
      '{"ok":true,"gaps":[]}',
    );
  });

  it("stripJsonFence skips a non-JSON brace in prose and finds the real object", () => {
    assert.equal(
      stripJsonFence(
        'The draft has {some issue} and the verdict is {"ok":true,"gaps":[]}',
      ),
      '{"ok":true,"gaps":[]}',
    );
  });

  it("stripJsonFence skips nested unbalanced prose braces before real JSON", () => {
    assert.equal(
      stripJsonFence(
        'Note {nested {broken} span before {"ok":true,"gaps":[]}',
      ),
      '{"ok":true,"gaps":[]}',
    );
  });

  it("stripJsonFence extracts a JSON array", () => {
    assert.equal(
      stripJsonFence('Here are the results: [1, 2, 3]'),
      '[1, 2, 3]',
    );
  });

  it("extractChatMessageText reads content string, parts, and reasoning fallbacks", () => {
    assert.equal(
      extractChatMessageText({ content: '  {"ok":true}  ' }),
      '{"ok":true}',
    );
    assert.equal(
      extractChatMessageText({
        content: [{ type: "text", text: '{"a":1}' }],
      }),
      '{"a":1}',
    );
    assert.equal(
      extractChatMessageText({
        content: "",
        reasoning_content: 'thinking...\n{"scope":"adopt_theme"}',
      }),
      'thinking...\n{"scope":"adopt_theme"}',
    );
    assert.equal(extractChatMessageText({ content: "   " }), "");
  });

  it("default JSON chat timeout is 5 minutes", () => {
    assert.equal(CHAT_JSON_DEFAULT_TIMEOUT_MS, 300_000);
  });

  it("isChatJsonTimeoutError / isRetryableChatJsonError cover abort", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    assert.equal(isChatJsonTimeoutError(abort), true);
    assert.equal(isRetryableChatJsonError(abort.message, abort), true);
    assert.equal(
      isRetryableChatJsonError("JSON chat timed out after 90000ms"),
      true,
    );
  });

  it("isRetryableChatJsonError covers transient 5xx/429 server errors", () => {
    // Hosted providers (e.g. ollama.com) return 500 under load — these must be
    // retryable so a transient blip does not burn a judge attempt instantly.
    assert.equal(isRetryableChatJsonError("JSON chat failed (500): boom"), true);
    assert.equal(isRetryableChatJsonError("JSON chat failed (502): bad gateway"), true);
    assert.equal(isRetryableChatJsonError("JSON chat failed (503): overloaded"), true);
    assert.equal(isRetryableChatJsonError("JSON chat failed (429): slow down"), true);
    assert.equal(isServerSideChatJsonError("JSON chat failed (500): boom"), true);
    assert.equal(isServerSideChatJsonError("JSON chat failed (429): slow down"), true);
    // 4xx client errors are deterministic — never retried.
    for (const status of [400, 401, 403, 404, 422]) {
      const msg = `JSON chat failed (${status}): nope`;
      assert.equal(isRetryableChatJsonError(msg), false, msg);
      assert.equal(isServerSideChatJsonError(msg), false, msg);
    }
    // Parse/empty-content failures are retryable but not server-side (no backoff).
    assert.equal(isServerSideChatJsonError("JSON chat parse failed: x"), false);
    assert.equal(isServerSideChatJsonError("JSON chat returned empty content"), false);
  });

  it("serverRetryDelayMs backs off exponentially and caps", () => {
    const d1 = serverRetryDelayMs(1);
    const d2 = serverRetryDelayMs(2);
    const d3 = serverRetryDelayMs(3);
    const d10 = serverRetryDelayMs(10);
    assert.ok(d1 >= 2_000 && d1 < 3_000, `d1=${d1}`);
    assert.ok(d2 >= 4_000 && d2 < 5_000, `d2=${d2}`);
    assert.ok(d3 >= 8_000 && d3 < 9_000, `d3=${d3}`);
    assert.ok(
      d10 >= CHAT_JSON_SERVER_RETRY_MAX_MS &&
        d10 < CHAT_JSON_SERVER_RETRY_MAX_MS + 1_000,
      `d10=${d10}`,
    );
  });

  it("isRetryableChatJsonError covers transient network/fetch failures", () => {
    assert.equal(isRetryableChatJsonError("fetch failed"), true);
    assert.equal(
      isRetryableChatJsonError("Cannot connect: Connect Timeout Error"),
      true,
    );
    assert.equal(isRetryableChatJsonError("UND_ERR_CONNECT_TIMEOUT"), true);
    assert.equal(isRetryableChatJsonError("getaddrinfo ENOTFOUND host"), true);
    assert.equal(isRetryableChatJsonError("socket hang up"), true);
    // 4xx client errors are NOT transient
    assert.equal(
      isRetryableChatJsonError("JSON chat failed (403): quota"),
      false,
    );
  });
});

describe("chatJson empty-content retry", () => {
  // These pin the compatibility (fetch) transport semantics.
  before(() => {
    process.env.SLOPCONTROL_JUDGE_TRANSPORT = "fetch";
  });
  after(() => {
    delete process.env.SLOPCONTROL_JUDGE_TRANSPORT;
  });

  it("retries empty content then succeeds", async () => {
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls < 2) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"scope":"sections","targets":[]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      const result = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        emptyContentRetries: 2,
      });
      assert.equal(calls, 2);
      assert.deepEqual(result.parsed, { scope: "sections", targets: [] });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("throws after exhausting empty-content retries", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      await assert.rejects(
        () =>
          chatJson({
            endpoint,
            system: "sys",
            user: "user",
            emptyContentRetries: 1,
          }),
        /empty content/,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries HTTP 500 with backoff then succeeds", async () => {
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true,"gaps":[]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const delays: number[] = [];
    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      const result = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        emptyContentRetries: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
      assert.equal(calls, 3);
      assert.deepEqual(result.parsed, { ok: true, gaps: [] });
      // Two retries, each preceded by a backoff sleep.
      assert.equal(delays.length, 2);
      assert.ok(delays[0]! >= 2_000, `first delay ${delays[0]}`);
      assert.ok(delays[1]! >= 4_000, `second delay ${delays[1]}`);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("does not retry deterministic 4xx errors", async () => {
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response("quota exceeded", { status: 403 });
    });
    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      await assert.rejects(
        () =>
          chatJson({
            endpoint,
            system: "sys",
            user: "user",
            sleep: async () => {},
          }),
        /JSON chat failed \(403\)/,
      );
      assert.equal(calls, 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("passes maxTokens override through to the request body", async () => {
    let seenMaxTokens: number | null = null;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          max_tokens?: number;
        };
        seenMaxTokens = body.max_tokens ?? null;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      await chatJson({ endpoint, system: "s", user: "u", maxTokens: 4096 });
      assert.equal(seenMaxTokens, 4096);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries prose (non-JSON) then succeeds on JSON-only nudge", async () => {
    let calls = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ content?: string }>;
        };
        if (calls === 1) {
          assert.equal(
            body.messages?.some((m) =>
              /IMPORTANT: Respond with ONLY/i.test(m.content ?? ""),
            ),
            false,
          );
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      "We are asking for clarification before returning JSON.",
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        assert.ok(
          body.messages?.some((m) =>
            /IMPORTANT: Respond with ONLY/i.test(m.content ?? ""),
          ),
          "retry should append JSON-only nudge",
        );
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"scope":"adopt_theme","targets":["palette"],"adoptTheme":true}',
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      const result = await chatJson({
        endpoint,
        system: "sys",
        user: "classify this",
        emptyContentRetries: 2,
      });
      assert.equal(calls, 2);
      assert.equal((result.parsed as { scope: string }).scope, "adopt_theme");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries AbortError as timed out then succeeds", async () => {
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"scope":"assets_only","targets":["logo"]}',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      const result = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        timeoutMs: 90_000,
        emptyContentRetries: 1,
        sleep: async () => {},
      });
      assert.equal(calls, 2);
      assert.equal((result.parsed as { scope: string }).scope, "assets_only");
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("exhausts timeout retries with clear timed-out message", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    try {
      const endpoint: LlmEndpoint = {
        id: "test",
        label: "test",
        baseUrl: "http://example.test/v1",
        apiType: "openai-chat",
        modelId: "test-model",
        capabilities: { chat: true, vision: false, imageGen: false },
      };
      await assert.rejects(
        () =>
          chatJson({
            endpoint,
            system: "sys",
            user: "user",
            timeoutMs: 90_000,
            emptyContentRetries: 1,
            sleep: async () => {},
          }),
        /JSON chat timed out after 90000ms/,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });
});


describe("chatJson schema validation", () => {
  before(() => {
    process.env.SLOPCONTROL_JUDGE_TRANSPORT = "fetch";
  });
  after(() => {
    delete process.env.SLOPCONTROL_JUDGE_TRANSPORT;
  });

  const endpoint: LlmEndpoint = {
    id: "test",
    label: "test",
    baseUrl: "http://example.test/v1",
    apiType: "openai-chat",
    modelId: "test-model",
    capabilities: { chat: true, vision: false, imageGen: false },
  };
  const schema = z.object({ targets: z.string(), intent: z.boolean().optional() });
  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("unwraps a single-element array for an object schema", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      reply('[{"targets":"both"}]'),
    );
    try {
      const result = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        schema,
      });
      assert.deepEqual(result.parsed, { targets: "both" });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries a shape mismatch with a nudge and keeps response_format", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const fetchMock = mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return calls === 1
        ? reply('[{"targets":"both"},{"targets":"phase"}]')
        : reply('{"targets":"research"}');
    });
    try {
      const result = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        schema,
        schemaHint: "Return ONE object",
      });
      assert.equal(calls, 2);
      assert.deepEqual(result.parsed, { targets: "research" });
      // response_format is never dropped for shape retries.
      for (const body of bodies) {
        assert.deepEqual(body.response_format, { type: "json_object" });
      }
      const retryMessages = bodies[1]?.messages as Array<{ role: string; content: string }>;
      const retryUser = retryMessages.find((m) => m.role === "user")?.content ?? "";
      assert.match(retryUser, /ONLY a single valid JSON object/);
      assert.match(retryUser, /failed schema validation/);
      assert.match(retryUser, /Return ONE object/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("throws a clean shape error (not a raw issues array) after retries", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => reply("[]"));
    try {
      await assert.rejects(
        () => chatJson({ endpoint, system: "sys", user: "user", schema }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /JSON shape invalid/);
          assert.doesNotMatch(msg, /"expected":/);
          return true;
        },
      );
    } finally {
      fetchMock.mock.restore();
    }
  });
});


describe("chatJson AI SDK transport", () => {
  const endpoint: LlmEndpoint = {
    id: "test",
    label: "test",
    baseUrl: "http://example.test/v1",
    apiType: "openai-chat",
    modelId: "test-model",
    capabilities: { chat: true, vision: false, imageGen: false },
  };
  const completion = (content: string, finishReason = "stop") =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          { index: 0, message: { role: "assistant", content }, finish_reason: finishReason },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const capture = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return completion('{"targets":"both"}');
      },
    );
    return { bodies, fetchMock };
  };
  const tokens = (body: Record<string, unknown>): number =>
    Number(body.max_tokens ?? body.max_completion_tokens ?? 0);

  it("uses structured output for a schema and returns the typed object", async () => {
    const { bodies, fetchMock } = capture();
    try {
      const res = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        schema: z.object({ targets: z.string() }),
      });
      assert.deepEqual(res.parsed, { targets: "both" });
      assert.equal(bodies.length, 1);
      assert.match(
        JSON.stringify(bodies[0]),
        /response_format|json_schema|json_object/,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("repairs fenced JSON via experimental_repairText", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      completion('Here you go:\n\n```json\n{"targets":"phase"}\n```\n'),
    );
    try {
      const res = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        schema: z.object({ targets: z.string() }),
      });
      assert.deepEqual(res.parsed, { targets: "phase" });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries once with a larger budget when output is truncated", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit) => {
        calls += 1;
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return calls === 1
          ? completion('{"targets":', "length")
          : completion('{"targets":"both"}');
      },
    );
    try {
      const res = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        schema: z.object({ targets: z.string() }),
        maxTokens: 1024,
      });
      assert.deepEqual(res.parsed, { targets: "both" });
      assert.equal(calls, 2);
      assert.ok(
        tokens(bodies[1]!) > tokens(bodies[0]!),
        `expected a larger budget, got ${tokens(bodies[0]!)} → ${tokens(bodies[1]!)}`,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("falls back to the compatibility transport when structured output is rejected", async () => {
    let calls = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit) => {
        calls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const structured =
          body.response_format !== undefined || body.tools !== undefined;
        if (calls === 1 && structured) {
          return new Response(
            JSON.stringify({ error: "response_format is not supported" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return completion('{"targets":"both"}');
      },
    );
    try {
      const res = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        schema: z.object({ targets: z.string() }),
      });
      assert.deepEqual(res.parsed, { targets: "both" });
      assert.ok(calls >= 2, `expected a fallback call, got ${calls}`);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("chatJson AI SDK transport ladder", () => {
  const endpoint: LlmEndpoint = {
    id: "test",
    label: "test",
    baseUrl: "http://example.test/v1",
    apiType: "openai-chat",
    modelId: "test-model",
    capabilities: { chat: true, vision: false, imageGen: false },
  };
  const completion = (content: string, finishReason = "stop") =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "test-model",
        choices: [
          { index: 0, message: { role: "assistant", content }, finish_reason: finishReason },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("parses fenced JSON on the no-schema text path", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      completion('Here is the answer:\n\n```json\n{"a":1}\n```'),
    );
    try {
      const res = await chatJson({ endpoint, system: "sys", user: "user" });
      assert.deepEqual(res.parsed, { a: 1 });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("retries the text path with a larger budget when truncated", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit) => {
        calls += 1;
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return calls === 1
          ? completion('{"a":1', "length")
          : completion('{"a":1}');
      },
    );
    const tokens = (b: Record<string, unknown>): number =>
      Number(b.max_tokens ?? b.max_completion_tokens ?? 0);
    try {
      const res = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        maxTokens: 512,
      });
      assert.deepEqual(res.parsed, { a: 1 });
      assert.equal(calls, 2);
      assert.ok(tokens(bodies[1]!) > tokens(bodies[0]!));
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("walks structured → text → fetch when structured output stays empty", async () => {
    let calls = 0;
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => {
        calls += 1;
        // 1: structured attempt (empty) → 2: text attempt (empty) → 3: fetch.
        return calls >= 3 ? completion('{"targets":"both"}') : completion("");
      },
    );
    try {
      const res = await chatJson({
        endpoint,
        system: "sys",
        user: "user",
        schema: z.object({ targets: z.string() }),
      });
      assert.deepEqual(res.parsed, { targets: "both" });
      assert.ok(calls >= 3, `expected structured, text, then fetch; got ${calls}`);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("surfaces the legacy timeout text when the provider hangs", async () => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    try {
      await assert.rejects(
        () =>
          chatJson({
            endpoint,
            system: "sys",
            user: "user",
            schema: z.object({ a: z.number() }),
            timeoutMs: 25,
            emptyContentRetries: 0,
          }),
        /JSON chat timed out after/,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("uses the direct transport for api types the AI SDK path declines", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return completion('{"a":1}');
      },
    );
    try {
      const res = await chatJson({
        endpoint: { ...endpoint, apiType: "openai-responses" },
        system: "sys",
        user: "user",
      });
      assert.deepEqual(res.parsed, { a: 1 });
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]?.response_format, undefined);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
