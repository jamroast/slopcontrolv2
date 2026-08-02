import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  ContinueIntentSchema,
  fallbackContinueIntentFromText,
} from "@slopcontrol/artifacts";
import { CONTINUE_INTENT_SYSTEM_PROMPT } from "./continue-intent-llm.js";

/**
 * Mirrors the post-chatJson validation + fallback merge inside
 * classifyContinueIntentViaLlm. (chatJson itself is covered in json-chat tests.)
 */
function mergeValidated(message: string, parsed: unknown) {
  const intent = ContinueIntentSchema.parse(parsed);
  // Same merge semantics as classifyContinueIntentViaLlm:
  // LLM fields win, targets pass through; fallback only fills when LLM omits.
  return {
    ...fallbackContinueIntentFromText(message),
    ...intent,
    targets: intent.targets,
  };
}

describe("continue-intent-llm", () => {
  it("system prompt documents logo/theme/nav intent rules", () => {
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("inventLogo"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("adoptTheme"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("navAlign"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("logo_invent"));
    assert.ok(
      CONTINUE_INTENT_SYSTEM_PROMPT.includes("prefer preserveChrome=false"),
      "theme/logo redesign must not default to preserving chrome",
    );
  });

  it("validates LLM JSON for invent-logo continue", async () => {
    const parsed = {
      scope: "logo_invent",
      targets: ["logo"],
      wantsAssetEdit: false,
      inventLogo: true,
      adoptTheme: false,
      navAlign: false,
      preserveChrome: true,
      notes: "Replace prior logo with a new circle mark",
    };
    const intent = ContinueIntentSchema.parse(parsed);
    assert.equal(intent.scope, "logo_invent");
    assert.equal(intent.inventLogo, true);
    assert.ok(intent.targets.includes("logo"));
  });

  it("validates adopt-theme + new logo JSON", () => {
    const parsed = {
      scope: "adopt_theme",
      targets: ["palette", "logo"],
      wantsAssetEdit: false,
      inventLogo: true,
      adoptTheme: true,
      navAlign: false,
      preserveChrome: true,
      notes: "Pull JamRoast palette and invent a new logo",
    };
    const intent = ContinueIntentSchema.parse(parsed);
    assert.equal(intent.adoptTheme, true);
    assert.equal(intent.inventLogo, true);
  });

  it("rejects invalid scope / target values", () => {
    assert.throws(() =>
      ContinueIntentSchema.parse({
        scope: "sometimes",
        targets: ["logo"],
        wantsAssetEdit: false,
        inventLogo: false,
        adoptTheme: false,
        navAlign: false,
        preserveChrome: true,
        notes: "",
      }),
    );
    assert.throws(() =>
      ContinueIntentSchema.parse({
        scope: "sections",
        targets: ["footer-thing"],
        wantsAssetEdit: false,
        inventLogo: false,
        adoptTheme: false,
        navAlign: false,
        preserveChrome: true,
        notes: "",
      }),
    );
  });

  it("merges validated LLM intent over regex fallback (LLM wins)", async () => {
    const chatJsonMock = mock.fn(async () => ({
      text: "{}",
      parsed: {
        scope: "logo_invent",
        targets: ["logo"],
        wantsAssetEdit: false,
        inventLogo: true,
        adoptTheme: false,
        navAlign: false,
        preserveChrome: true,
        notes: "",
      },
      modelId: "test-model",
    }));
    const { parsed } = await chatJsonMock();
    const merged = mergeValidated(
      "Please keep the layout and invent a new symbolic logo",
      parsed,
    );
    assert.equal(merged.scope, "logo_invent");
    assert.equal(merged.inventLogo, true);
    assert.ok(merged.targets.includes("logo"));
    assert.equal(chatJsonMock.mock.callCount(), 1);
  });
});
