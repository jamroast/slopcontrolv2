import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { LlmEndpoint } from "@slopcontrol/types";
import {
  RESEARCH_QUALITY_SYSTEM_PROMPT,
  judgeResearchQualityViaLlm,
  parseResearchQualityVerdictPayload,
} from "./research-quality-llm.js";

const endpoint: LlmEndpoint = {
  id: "test",
  label: "test",
  baseUrl: "http://example.test/v1",
  apiType: "openai-chat",
  modelId: "test-model",
  capabilities: { chat: true, vision: false, imageGen: false },
};

describe("research-quality-llm", () => {
  it("system prompt requires concrete research before drafting", () => {
    assert.match(RESEARCH_QUALITY_SYSTEM_PROMPT, /Proposed Automated Checks/);
    assert.match(RESEARCH_QUALITY_SYSTEM_PROMPT, /fail closed/i);
  });

  it("parses an ok verdict", () => {
    const verdict = parseResearchQualityVerdictPayload({
      ok: true,
      gaps: [],
      suggestedFixes: [],
    });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.gaps, []);
  });

  it("fails closed on unreadable payload", () => {
    const verdict = parseResearchQualityVerdictPayload("not json");
    assert.equal(verdict.ok, false);
    assert.match(verdict.gaps[0] ?? "", /could not be verified/i);
  });

  it("keeps the middle of a research doc a 16k head+tail clip would drop", async () => {
    const research =
      `HEAD_TOKEN ${"h".repeat(8_000)}` +
      `MIDDLE_TOKEN ${"m".repeat(20_000)}` +
      `${"t".repeat(8_000)} TAIL_TOKEN`;
    let user = "";
    const fetchMock = mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      user = body.messages?.find((m) => m.role === "user")?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true,"gaps":[],"suggestedFixes":[]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      const verdict = await judgeResearchQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: research,
      });
      assert.equal(verdict.ok, true);
      assert.match(user, /HEAD_TOKEN/);
      assert.match(user, /MIDDLE_TOKEN/);
      assert.match(user, /TAIL_TOKEN/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("keeps the tail of a research doc longer than the excerpt budget", async () => {
    const research = `${"h".repeat(100_000)}TAIL_TOKEN`;
    let user = "";
    const fetchMock = mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      user = body.messages?.find((m) => m.role === "user")?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true,"gaps":[],"suggestedFixes":[]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      await judgeResearchQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: research,
      });
      assert.match(user, /TAIL_TOKEN/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("accepts a verdict that omits suggestedFixes", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":false,"gaps":["name the files"]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      const verdict = await judgeResearchQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: "research",
      });
      assert.equal(verdict.ok, false);
      assert.deepEqual(verdict.gaps, ["name the files"]);
      assert.deepEqual(verdict.suggestedFixes, []);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
