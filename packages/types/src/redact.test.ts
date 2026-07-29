import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets, safeJsonForLog } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts bearer tokens and env-style secrets", () => {
    const raw =
      'Authorization: Bearer 07c987d90d9149c2879b16153f049715.secret -H "Authorization: Bearer abc.def" OLLAMA_API_KEY=oll-supersecret123';
    const out = redactSecrets(raw);
    assert.doesNotMatch(out, /07c987d90d9149/);
    assert.doesNotMatch(out, /supersecret/);
    assert.match(out, /Bearer \*\*\*/);
    assert.match(out, /OLLAMA_API_KEY=\*\*\*/);
  });

  it("safeJsonForLog truncates and redacts", () => {
    const out = safeJsonForLog(
      { command: "curl -H Authorization: Bearer sk-abcdefghijklmnop" },
      200,
    );
    assert.doesNotMatch(out, /sk-abcdefghijklmnop/);
    assert.ok(out.length <= 200);
  });
});
