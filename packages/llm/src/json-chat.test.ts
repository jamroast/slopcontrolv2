import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  CHAT_JSON_DEFAULT_TIMEOUT_MS,
  extractChatMessageText,
  isChatJsonTimeoutError,
  isRetryableChatJsonError,
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

  it("default classification timeout is 90s", () => {
    assert.equal(CHAT_JSON_DEFAULT_TIMEOUT_MS, 90_000);
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
    assert.equal(isRetryableChatJsonError("JSON chat failed (500): boom"), false);
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
          }),
        /JSON chat timed out after 90000ms/,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });
});
