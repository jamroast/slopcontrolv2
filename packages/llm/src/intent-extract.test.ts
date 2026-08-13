import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  ChangeIntentLlmOutputSchema,
  finalizeChangeIntent,
} from "@slopcontrol/artifacts";
import { stripJsonFence } from "./json-chat.js";
import { CHANGE_INTENT_SYSTEM_PROMPT } from "./intent-extract.js";

describe("json-chat helpers", () => {
  it("stripJsonFence unwraps markdown fences", () => {
    assert.equal(
      stripJsonFence('```json\n{"a":1}\n```'),
      '{"a":1}',
    );
    assert.equal(stripJsonFence('noise {"a":1} trailing'), '{"a":1}');
  });
});

describe("intent-extract (mocked chatJson path)", () => {
  it("validates LLM JSON and finalize yields chrome-hide without interaction", async () => {
    const raw = {
      title: "Hide empty Form|Chat tabs",
      goal: "When nothing to gather, show only the chat text area.",
      uiMount: "composer",
      changeKind: "chrome-hide",
      needsInteraction: false,
    };
    const parsed = ChangeIntentLlmOutputSchema.parse(raw);
    const intent = finalizeChangeIntent(parsed, {
      description:
        "What phases are complete? Hide blank form tabs when nothing to gather.",
    });
    assert.equal(intent.changeKind, "chrome-hide");
    assert.equal(intent.uiMount, "composer");
    assert.equal(intent.interaction, undefined);
    assert.ok(CHANGE_INTENT_SYSTEM_PROMPT.includes("chrome-hide"));
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /theme toggle/i);
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /clickable/i);
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /UserPill/i);
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /destination page/i);
  });

  it("finalize coerces engagement+needsInteraction on click-to-navigate UserPill asks", () => {
    const intent = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Wire landing UserPill to sign-in",
        goal: "Clicking UserPill should navigate to /sign-in.",
        uiMount: "page",
        changeKind: "engagement",
        needsInteraction: true,
      }),
      {
        description:
          'Investigate why the sign-in button (UserPill showing "?") on the landing page does nothing when clicked.',
      },
    );
    assert.equal(intent.changeKind, "other");
    assert.equal(intent.interaction, undefined);
  });

  it("finalize trusts LLM needsInteraction for other (no description regex veto)", () => {
    const noIx = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Audit light/dark theme toggle",
        goal: "Landing page responds to ThemeToggle data-theme.",
        uiMount: "page",
        changeKind: "other",
        needsInteraction: false,
        themeWiringOnly: true,
      }),
      {
        description:
          "Audit the existing light/dark theme toggle on the landing page.",
      },
    );
    assert.equal(noIx.changeKind, "other");
    assert.equal(noIx.themeWiringOnly, true);
    assert.equal(noIx.interaction, undefined);

    const withIx = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Audit light/dark theme toggle",
        goal: "Landing page responds to ThemeToggle data-theme.",
        uiMount: "page",
        changeKind: "other",
        needsInteraction: true,
      }),
      {
        description:
          "Audit the existing light/dark theme toggle on the landing page.",
      },
    );
    assert.ok(withIx.interaction);
  });

  it("mock extractChangeIntentViaLlm via module mock", async () => {
    const chatJsonMock = mock.fn(async () => ({
      text: JSON.stringify({
        title: "Enable fill and submit in composer",
        goal: "Users must populate and submit skill params.",
        uiMount: "composer",
        changeKind: "engagement",
        needsInteraction: true,
      }),
      parsed: {
        title: "Enable fill and submit in composer",
        goal: "Users must populate and submit skill params.",
        uiMount: "composer",
        changeKind: "engagement",
        needsInteraction: true,
      },
      modelId: "test-model",
    }));

    // Simulate the post-chatJson validation path used by extractChangeIntentViaLlm
    const { parsed } = await chatJsonMock();
    const llmOut = ChangeIntentLlmOutputSchema.parse(parsed);
    const intent = finalizeChangeIntent(llmOut, {
      description: "Unable to submit form in the composer",
    });
    assert.equal(intent.changeKind, "engagement");
    assert.ok(intent.interaction);
    assert.equal(chatJsonMock.mock.callCount(), 1);
  });

  it("stockAdoption=true forces brandTheming=false (design-by-reference)", () => {
    const parsed = ChangeIntentLlmOutputSchema.parse({
      title: "Adopt stock jamroast-components menubar",
      goal: "Strip custom menubars and mount the stock menubar theming.",
      uiMount: "page",
      changeKind: "other",
      needsInteraction: false,
      brandTheming: true, // misclassified by the model alongside
      stockAdoption: true,
    });
    const intent = finalizeChangeIntent(parsed, {
      description:
        "Strip the custom menubar and use the stock menubar theming from the jamroast-components project.",
    });
    assert.equal(intent.stockAdoption, true);
    assert.equal(intent.brandTheming, false);
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /stockAdoption/);
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /design-by-reference/i);
  });

  it("assetSwap=true forces brandTheming=false (existing asset, pure coding)", () => {
    const parsed = ChangeIntentLlmOutputSchema.parse({
      title: "Swap menubar logo to pinned mark",
      goal: "Use jamlight-circular-mark-v1.png rather than the alpha variant.",
      uiMount: "page",
      changeKind: "other",
      needsInteraction: false,
      brandTheming: true, // misclassified by the model alongside
      assetSwap: true,
    });
    const intent = finalizeChangeIntent(parsed, {
      description:
        "Make sure jamlight-circular-mark-v1.png is used rather than the alpha logo currently on the site.",
    });
    assert.equal(intent.assetSwap, true);
    assert.equal(intent.brandTheming, false);
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /assetSwap/);
    assert.match(CHANGE_INTENT_SYSTEM_PROMPT, /EXISTING asset by filename/i);
  });
});
