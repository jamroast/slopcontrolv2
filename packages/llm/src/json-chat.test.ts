import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  extractChatMessageText,
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
          body.messages?.some((m) => /IMPORTANT: Respond with ONLY/i.test(m.content ?? "")),
          false,
        );
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "We are asking for clarification before returning JSON.",
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
                content: '{"scope":"adopt_theme","targets":["palette"],"adoptTheme":true}',
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
});
