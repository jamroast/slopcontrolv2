import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets } from "./redact-secrets.js";

describe("redactSecrets", () => {
  it("redacts OLLAMA_API_KEY assignment lines", () => {
    const raw =
      "OLLAMA_BASE_URL=http://192.168.3.107:11434/v1\nOLLAMA_API_KEY=secret.value.here\nOLLAMA_TIER=paid\n";
    const out = redactSecrets(raw);
    assert.match(out, /OLLAMA_API_KEY=\[REDACTED len=\d+\]/);
    assert.doesNotMatch(out, /secret\.value\.here/);
    assert.match(out, /192\.168\.3\.107/);
  });

  it("redacts Bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer abc.def.ghi");
    assert.match(out, /Bearer \[REDACTED len=/);
    assert.doesNotMatch(out, /abc\.def\.ghi/);
  });
});
