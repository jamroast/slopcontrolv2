import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodingSessionAckError,
  getCodingTool,
  listCodingTools,
  OpenCodeAckTimeoutError,
  PiAdapter,
  piAckPrompt,
  piApiTypeFor,
  piModelFor,
  piSessionPreamble,
  PI_INVESTIGATE_SYSTEM_PROMPT,
  formatInvestigateDirtyTree,
} from "./index.js";
import type { LlmEndpoint } from "@slopcontrol/types";

const OPENAI_ENDPOINT: LlmEndpoint = {
  id: "ep-openai",
  baseUrl: "https://api.openai.com/v1",
  apiType: "openai-completions",
  modelId: "gpt-5.2",
  apiKey: "sk-test",
};

const ANTHROPIC_ENDPOINT: LlmEndpoint = {
  id: "ep-anthropic",
  baseUrl: "https://api.anthropic.com",
  apiType: "anthropic-messages",
  modelId: "claude-sonnet-4-5",
  apiKey: "sk-ant-test",
};

const LOCAL_ENDPOINT: LlmEndpoint = {
  id: "ep-ollama",
  baseUrl: "http://localhost:11434/v1",
  apiType: "openai-completions",
  modelId: "qwen3-coder",
};

describe("piApiTypeFor", () => {
  it("maps anthropic-messages through, everything else to openai-completions", () => {
    assert.equal(piApiTypeFor("anthropic-messages"), "anthropic-messages");
    assert.equal(piApiTypeFor("openai-completions"), "openai-completions");
    assert.equal(piApiTypeFor("openai-responses"), "openai-completions");
    assert.equal(piApiTypeFor(undefined), "openai-completions");
  });
});

describe("piModelFor", () => {
  it("maps a plain openai endpoint without touching the network catalog", () => {
    const model = piModelFor(OPENAI_ENDPOINT);
    assert.equal(model?.provider, "openai");
    assert.equal(model?.id, "gpt-5.2");
    assert.equal(model?.api, "openai-completions");
    assert.equal(model?.baseUrl, "https://api.openai.com/v1");
  });

  it("maps anthropic-messages endpoints to the anthropic provider+api", () => {
    const model = piModelFor(ANTHROPIC_ENDPOINT);
    assert.equal(model?.provider, "anthropic");
    assert.equal(model?.api, "anthropic-messages");
  });

  it("honours an explicit known provider prefix in the model id", () => {
    const model = piModelFor(OPENAI_ENDPOINT, "anthropic/claude-sonnet-4-5");
    assert.equal(model?.provider, "anthropic");
    assert.equal(model?.id, "claude-sonnet-4-5");
  });

  it("strips unknown prefixes by falling back to URL heuristics", () => {
    const model = piModelFor(
      {
        ...ANTHROPIC_ENDPOINT,
        baseUrl: "http://proxy.internal:8080/anthropic",
      },
      "custom/claude-sonnet-4-5",
    );
    assert.equal(model?.provider, "anthropic");
    assert.equal(model?.id, "custom/claude-sonnet-4-5");
  });

  it("maps local ollama endpoints to the ollama provider", () => {
    const model = piModelFor(LOCAL_ENDPOINT, "ollama/qwen3-coder");
    assert.equal(model?.provider, "ollama");
    assert.equal(model?.id, "qwen3-coder");
    assert.equal(model?.api, "openai-completions");
  });

  it("passes endpoint headers through onto the model", () => {
    const model = piModelFor({
      ...OPENAI_ENDPOINT,
      headers: { "X-Tenant": "acme" },
    });
    // The endpoint apiKey is always attached as a Bearer header (custom
    // baseUrl models bypass pi's catalog auth lookup).
    assert.deepEqual(model?.headers, {
      "X-Tenant": "acme",
      Authorization: `Bearer ${OPENAI_ENDPOINT.apiKey}`,
    });
  });

  it("returns undefined when no model id is available", () => {
    assert.equal(
      piModelFor({ ...OPENAI_ENDPOINT, modelId: "" } as LlmEndpoint),
      undefined,
    );
    assert.equal(piModelFor(undefined, undefined), undefined);
  });
});

describe("registry routing", () => {
  it("registers pi alongside opencode", () => {
    const ids = listCodingTools()
      .map((t) => t.id)
      .sort();
    assert.deepEqual(ids, ["opencode", "pi"]);
  });

  it("getCodingTool('pi') returns the PiAdapter", () => {
    const tool = getCodingTool("pi");
    assert.equal(tool.id, "pi");
    assert.ok(tool instanceof PiAdapter);
  });
});

describe("CodingSessionAckError", () => {
  it("carries toolId and abortReason with a greppable message", () => {
    const err = new CodingSessionAckError("pi", "turn_idle");
    assert.equal(err.name, "CodingSessionAckError");
    assert.equal(err.toolId, "pi");
    assert.equal(err.abortReason, "turn_idle");
    assert.match(err.message, /^pi session ack aborted: turn_idle$/);
    assert.ok(err instanceof Error);
  });

  it("OpenCodeAckTimeoutError stays a subtype so existing catch sites work", () => {
    const err = new OpenCodeAckTimeoutError("turn_timeout");
    assert.ok(err instanceof CodingSessionAckError);
    assert.equal(err.toolId, "opencode");
    assert.equal(err.abortReason, "turn_timeout");
    // Historical message shape preserved for log greps.
    assert.match(err.message, /^OpenCode session ack aborted: turn_timeout$/);
  });
});

describe("pi investigate mode helpers", () => {
  it("ack prompt is inspect-not-implement", () => {
    assert.match(piAckPrompt("investigate"), /inspect the codebase/i);
    assert.match(piAckPrompt("investigate"), /Do not change files/i);
    assert.doesNotMatch(piAckPrompt("investigate"), /ready to implement/i);
    assert.match(piAckPrompt("implement"), /ready to implement/i);
    const preamble = piSessionPreamble("/tmp/proj", "investigate");
    assert.match(preamble, /Ask/i);
    assert.doesNotMatch(preamble, /PHASE.md/);
    assert.match(PI_INVESTIGATE_SYSTEM_PROMPT, /Do NOT write/i);
    assert.equal(formatInvestigateDirtyTree([]), null);
    assert.match(
      formatInvestigateDirtyTree(["src/app/page.tsx"]) ?? "",
      /modified files/i,
    );
  });
});
