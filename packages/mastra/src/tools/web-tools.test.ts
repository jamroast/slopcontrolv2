import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBlockedIp,
  validateFetchUrl,
  fetchUrlContent,
  webSearchExa,
  FETCH_URL_MAX_BYTES,
} from "./web-tools.js";

describe("web-tools SSRF / fetch_url", () => {
  it("blocks localhost and private IPs", () => {
    assert.equal(isBlockedIp("localhost"), true);
    assert.equal(isBlockedIp("127.0.0.1"), true);
    assert.equal(isBlockedIp("10.0.0.1"), true);
    assert.equal(isBlockedIp("192.168.1.1"), true);
    assert.equal(isBlockedIp("172.16.5.1"), true);
    assert.equal(isBlockedIp("169.254.169.254"), true);
    assert.equal(isBlockedIp("ollama.com"), false);
  });

  it("validateFetchUrl requires https and public hosts", () => {
    assert.equal(validateFetchUrl("http://example.com").ok, false);
    assert.equal(validateFetchUrl("https://127.0.0.1/x").ok, false);
    assert.equal(validateFetchUrl("https://localhost/x").ok, false);
    const ok = validateFetchUrl("https://docs.ollama.com/api");
    assert.equal(ok.ok, true);
  });

  it("fetchUrlContent rejects SSRF without calling network", async () => {
    let called = false;
    const result = await fetchUrlContent("https://127.0.0.1/secret", {
      fetchImpl: async () => {
        called = true;
        return new Response("nope");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /SSRF|Blocked/i);
    assert.equal(called, false);
  });

  it("fetchUrlContent returns truncated text on success", async () => {
    const body = "hello world ".repeat(20);
    const result = await fetchUrlContent("https://example.com/doc", {
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });
    assert.equal(result.ok, true);
    assert.ok((result.text?.length ?? 0) > 0);
    assert.ok((result.text?.length ?? 0) <= FETCH_URL_MAX_BYTES);
  });
});

describe("web_search Exa", () => {
  it("returns clear error when Exa key is missing", async () => {
    const prevExa = process.env.EXA_API_KEY;
    const prevSc = process.env.SLOPCONTROL_EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.SLOPCONTROL_EXA_API_KEY;
    try {
      const result = await webSearchExa("ollama openai compatible api");
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /EXA_API_KEY/);
    } finally {
      if (prevExa !== undefined) process.env.EXA_API_KEY = prevExa;
      else delete process.env.EXA_API_KEY;
      if (prevSc !== undefined) process.env.SLOPCONTROL_EXA_API_KEY = prevSc;
      else delete process.env.SLOPCONTROL_EXA_API_KEY;
    }
  });

  it("parses Exa search results when key is set", async () => {
    const prev = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "test-key";
    try {
      const result = await webSearchExa("glm-5.2 ollama", {
        fetchImpl: async (_url, init) => {
          const headers = init?.headers as Record<string, string>;
          assert.equal(headers["x-api-key"], "test-key");
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "GLM-5.2",
                  url: "https://ollama.com/library/glm-5.2",
                  text: "Cloud model docs",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });
      assert.equal(result.ok, true);
      assert.equal(result.results?.length, 1);
      assert.equal(result.results?.[0]?.url, "https://ollama.com/library/glm-5.2");
    } finally {
      if (prev !== undefined) process.env.EXA_API_KEY = prev;
      else delete process.env.EXA_API_KEY;
    }
  });
});
