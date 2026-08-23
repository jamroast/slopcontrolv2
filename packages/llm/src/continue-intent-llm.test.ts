import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ContinueIntentSchema,
  normalizeContinueIntentStructured,
} from "@slopcontrol/artifacts";
import { CONTINUE_INTENT_SYSTEM_PROMPT } from "./continue-intent-llm.js";

describe("continue-intent-llm", () => {
  it("system prompt documents logo/theme/nav/shareFrom intent rules", () => {
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("inventLogo"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("inventLogoCount"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("assetOps"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("make_transparent"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("circular_mask"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("cut out the circular logo"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("7 different logos"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("adoptTheme"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("adoptChrome"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("look and feel"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("reuseProjectDesign"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("shareFrom"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("the components library"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("navAlign"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("logo_invent"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("unhappy with the logos"));
    assert.ok(
      CONTINUE_INTENT_SYSTEM_PROMPT.includes("prefer preserveChrome=false"),
      "theme/logo redesign must not default to preserving chrome",
    );
  });

  it("structured normalize prefers assetOps over inventLogo when both set", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "logo_invent",
        targets: ["logo"],
        wantsAssetEdit: true,
        assetOps: ["make_transparent", "derive_icon_pack"],
        inventLogo: true,
        adoptTheme: false,
        navAlign: false,
        preserveChrome: false,
        notes: "cut out + pack",
      }),
    );
    assert.equal(intent.inventLogo, false);
    assert.equal(intent.wantsAssetEdit, true);
    assert.deepEqual(intent.assetOps, [
      "make_transparent",
      "derive_icon_pack",
    ]);
    assert.equal(intent.scope, "assets_only");
  });

  it("structured normalize does not invent inventLogo from text when LLM omitted it", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "sections",
        targets: [],
        wantsAssetEdit: false,
        inventLogo: false,
        adoptTheme: false,
        navAlign: false,
        preserveChrome: true,
        notes: "noop",
      }),
    );
    assert.equal(intent.inventLogo, false);
    assert.equal(intent.preserveChrome, true);
  });

  it("structured normalize coerces inventLogo + assets_only away from assets_only", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "assets_only",
        targets: ["logo"],
        wantsAssetEdit: true,
        inventLogo: true,
        adoptTheme: false,
        navAlign: false,
        preserveChrome: false,
        notes: "new mark",
      }),
    );
    assert.equal(intent.inventLogo, true);
    assert.equal(intent.wantsAssetEdit, false);
    assert.notEqual(intent.scope, "assets_only");
  });

  it("validates LLM JSON for invent-logo continue", () => {
    const parsed = {
      scope: "logo_invent",
      targets: ["logo"],
      wantsAssetEdit: false,
      inventLogo: true,
      adoptTheme: false,
      navAlign: false,
      preserveChrome: false,
      notes: "Replace prior logo with a new circle mark",
    };
    const intent = ContinueIntentSchema.parse(parsed);
    assert.equal(intent.scope, "logo_invent");
    assert.equal(intent.inventLogo, true);
    assert.ok(intent.targets.includes("logo"));
  });

  it("validates adopt-theme + shareFrom for jamroast-components phrasing", () => {
    const parsed = {
      scope: "adopt_theme",
      targets: ["palette", "landing", "dashboard"],
      wantsAssetEdit: false,
      inventLogo: false,
      adoptTheme: true,
      shareFrom: "jamroast-components",
      navAlign: false,
      preserveChrome: false,
      notes: "Mock landing + dashboard using jamroast-components",
    };
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse(parsed),
    );
    assert.equal(intent.adoptTheme, true);
    assert.equal(intent.shareFrom, "jamroast-components");
    assert.ok(intent.targets.includes("palette"));
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

  it("LLM success path trusts preserveChrome when inventLogo is set", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "logo_invent",
        targets: ["logo"],
        wantsAssetEdit: false,
        inventLogo: true,
        adoptTheme: false,
        navAlign: false,
        preserveChrome: true,
        notes: "keep layout, new logo",
      }),
    );
    assert.equal(intent.inventLogo, true);
    assert.equal(intent.preserveChrome, true);
  });
});

describe("continue-intent-llm facet overrides", () => {
  it("system prompt documents inherit-by-default + facet override rules", () => {
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("freshDesign"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("replaceDesignFacets"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("INHERIT BY DEFAULT"));
    assert.ok(CONTINUE_INTENT_SYSTEM_PROMPT.includes("clean slate"));
  });

  it("schema round-trips facet fields from LLM JSON", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "sections",
        replaceDesignFacets: ["theme", "graphics"],
        freshDesign: false,
        notes: "new theme + graphics, keep logo",
      }),
    );
    assert.deepEqual([...intent.replaceDesignFacets].sort(), [
      "graphics",
      "theme",
    ]);
    assert.equal(intent.freshDesign, false);
  });

  it("freshDesign from LLM expands to all facets in normalize", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "full_revise",
        freshDesign: true,
        notes: "rebrand from scratch",
      }),
    );
    assert.deepEqual([...intent.replaceDesignFacets].sort(), [
      "graphics",
      "layout",
      "logo",
      "theme",
    ]);
  });

  it("omitted facet fields default to full inherit", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({ scope: "full_revise", notes: "new dashboard mock" }),
    );
    assert.equal(intent.freshDesign, false);
    assert.deepEqual(intent.replaceDesignFacets, []);
  });
});
