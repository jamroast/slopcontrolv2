import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
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
