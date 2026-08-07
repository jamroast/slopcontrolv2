import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEPENDENCY_INTENT_SYSTEM_PROMPT,
  shouldClassifyDependencyIntent,
} from "./dependency-intent-llm.js";

describe("dependency-intent-llm", () => {
  it("system prompt forbids npm link and requires JSON", () => {
    assert.match(DEPENDENCY_INTENT_SYSTEM_PROMPT, /npm link/i);
    assert.match(DEPENDENCY_INTENT_SYSTEM_PROMPT, /JSON/);
    assert.match(DEPENDENCY_INTENT_SYSTEM_PROMPT, /forbidNpmLink/);
    assert.match(DEPENDENCY_INTENT_SYSTEM_PROMPT, /look and feel/i);
    assert.match(DEPENDENCY_INTENT_SYSTEM_PROMPT, /theme-toggle/);
    assert.match(DEPENDENCY_INTENT_SYSTEM_PROMPT, /importAllElementsFrom/);
    assert.match(DEPENDENCY_INTENT_SYSTEM_PROMPT, /useElements/);
  });

  it("shouldClassifyDependencyIntent still detects linking language (deprecated pre-gate)", () => {
    // Classification always runs when text is present; this helper is legacy/test-only.
    assert.equal(
      shouldClassifyDependencyIntent("use theme-toggle from jamroast"),
      true,
    );
    assert.equal(shouldClassifyDependencyIntent("add @jam/foo"), true);
    assert.equal(shouldClassifyDependencyIntent("what is BLUEPRINT?"), false);
  });
});
