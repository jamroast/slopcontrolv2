import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTINUE_INTENT_DEFAULT,
  ContinueIntentSchema,
  continueIntentAllowsLogoSwap,
  continueIntentAllowsRedesign,
  continueIntentAllowsTokenChurn,
  continueIntentMayTouchHero,
  continueIntentMayTouchNav,
  continueIntentMayTouchShell,
  fallbackContinueIntentFromText,
  textSignalsReuseProjectDesign,
} from "./continue-intent.js";

describe("continue-intent schema", () => {
  it("applies defaults for omitted fields", () => {
    const intent = ContinueIntentSchema.parse({ scope: "sections" });
    assert.deepEqual(intent.targets, []);
    assert.equal(intent.wantsAssetEdit, false);
    assert.equal(intent.inventLogo, false);
    assert.equal(intent.adoptTheme, false);
    assert.equal(intent.reuseProjectDesign, false);
    assert.equal(intent.navAlign, false);
    assert.equal(intent.preserveChrome, false);
    assert.equal(intent.notes, "");
  });

  it("rejects unknown scope and targets", () => {
    assert.throws(() => ContinueIntentSchema.parse({ scope: "nope" }));
    assert.throws(() =>
      ContinueIntentSchema.parse({ scope: "sections", targets: ["footer"] }),
    );
  });

  it("CONTINUE_INTENT_DEFAULT is valid and conservative", () => {
    const intent = ContinueIntentSchema.parse(CONTINUE_INTENT_DEFAULT);
    assert.equal(intent.scope, "sections");
    assert.equal(intent.preserveChrome, true);
  });
});

describe("fallbackContinueIntentFromText", () => {
  it("detects icon pack as assets_only-ish with wantsAssetEdit", () => {
    const intent = fallbackContinueIntentFromText(
      "Please regenerate the icon pack now that the alpha is correct",
    );
    assert.equal(intent.wantsAssetEdit, true);
    assert.equal(intent.scope, "assets_only");
  });

  it("does not treat 'do not change hero' as a hero target", () => {
    const intent = fallbackContinueIntentFromText(
      "Keep the layout. Derive icon pack. Do not change hero or shell.",
    );
    assert.equal(intent.preserveChrome, true);
    assert.ok(!intent.targets.includes("hero"));
    assert.ok(!intent.targets.includes("shell"));
  });

  it("detects nav align with code", () => {
    const intent = fallbackContinueIntentFromText(
      "Please align the menu items with what we have today in the code",
    );
    assert.equal(intent.navAlign, true);
    assert.equal(intent.scope, "nav_align");
    assert.ok(intent.targets.includes("nav"));
  });

  it("detects new symbolic logo", () => {
    const intent = fallbackContinueIntentFromText(
      "Invent a new symbolic logo for the CRM",
    );
    assert.equal(intent.inventLogo, true);
    assert.ok(intent.targets.includes("logo"));
    assert.equal(intent.preserveChrome, false);
  });

  it("detects dissatisfaction / replace logo language as inventLogo", () => {
    for (const ask of [
      "I am unhappy with the logos",
      "I don't like the current logos",
      "Please replace the logos",
      "Can we try different logos",
      "change the logo",
    ]) {
      const intent = fallbackContinueIntentFromText(ask);
      assert.equal(intent.inventLogo, true, ask);
      assert.notEqual(intent.scope, "assets_only", ask);
      assert.equal(intent.preserveChrome, false, ask);
    }
  });

  it("detects adopt theme from sibling project", () => {
    const intent = fallbackContinueIntentFromText(
      "Pull the theming from MyBrand into this mock",
    );
    assert.equal(intent.adoptTheme, true);
    assert.equal(intent.reuseProjectDesign, false);
    assert.ok(intent.targets.includes("palette"));
  });

  it("detects reuse of this project's current theming (not sibling)", () => {
    const ask =
      "Please can you pull out the current theming and generate me a mock landing page and dashboard using the current theming and design concepts";
    assert.equal(textSignalsReuseProjectDesign(ask), true);
    const intent = fallbackContinueIntentFromText(ask);
    assert.equal(intent.reuseProjectDesign, true);
    assert.equal(intent.adoptTheme, false);
    assert.ok(intent.targets.includes("palette"));
    assert.equal(intent.scope, "adopt_theme");
  });

  it("existing design concepts signals reuseProjectDesign", () => {
    const intent = fallbackContinueIntentFromText(
      "Use the existing design concepts and design pack for a new landing mock",
    );
    assert.equal(intent.reuseProjectDesign, true);
    assert.equal(intent.adoptTheme, false);
  });

  it("bare brand mention without adopt/from does not set adoptTheme", () => {
    const intent = fallbackContinueIntentFromText(
      "jamroast looks nice but just tweak the hero spacing",
    );
    assert.equal(intent.adoptTheme, false);
  });

  it("detects full redesign as full_revise", () => {
    const intent = fallbackContinueIntentFromText(
      "Redesign the whole landing from scratch",
    );
    assert.equal(intent.scope, "full_revise");
  });

  it("mixed theming + logo stays sections scope with both flags", () => {
    const intent = fallbackContinueIntentFromText(
      "Pull JamRoast theming from /Users/x/Projects/burntjam and invent a new symbolic logo",
    );
    assert.equal(intent.inventLogo, true);
    assert.equal(intent.adoptTheme, true);
    assert.equal(intent.scope, "sections");
  });
});

describe("continue-intent eval fixture (real operator asks)", () => {
  const cases: Array<{
    ask: string;
    expect: Partial<ReturnType<typeof fallbackContinueIntentFromText>>;
  }> = [
    {
      ask: "Please regenerate the icon pack now that the alpha channel is correct",
      expect: { scope: "assets_only", wantsAssetEdit: true },
    },
    {
      ask: "That looks good, the menu items do not align with what exists today. Could you please align with what we have today in the code",
      expect: { scope: "nav_align", navAlign: true },
    },
    {
      ask: "Keep the v7 layout. Derive icon pack. But please align the menu items with what is in place today",
      expect: { scope: "nav_align", navAlign: true, wantsAssetEdit: true },
    },
    {
      ask: "Pull the JamRoast theming from burntjam and invent a new symbolic logo",
      expect: { scope: "sections", inventLogo: true, adoptTheme: true },
    },
    {
      ask: "Invent a new symbolic logo for this product",
      expect: { inventLogo: true },
    },
    {
      ask: "I am unhappy with the logos — please invent new ones",
      expect: { inventLogo: true, preserveChrome: false },
    },
    {
      ask: "Do not change hero or shell. Just make the logo transparent and re-derive the icon pack",
      expect: { wantsAssetEdit: true, preserveChrome: true },
    },
    {
      ask: "Redesign the whole landing from scratch",
      expect: { scope: "full_revise" },
    },
  ];

  for (const c of cases) {
    it(`classifies: ${c.ask.slice(0, 60)}…`, () => {
      const intent = fallbackContinueIntentFromText(c.ask);
      for (const [key, value] of Object.entries(c.expect)) {
        assert.equal(
          (intent as unknown as Record<string, unknown>)[key],
          value,
          `${key} expected ${String(value)} got ${String((intent as unknown as Record<string, unknown>)[key])}`,
        );
      }
    });
  }
});

describe("continue-intent allow gates", () => {
  const base = ContinueIntentSchema.parse({ scope: "sections" });

  it("logo swap allowed for inventLogo or logo target", () => {
    assert.equal(
      continueIntentAllowsLogoSwap({ ...base, inventLogo: true }),
      true,
    );
    assert.equal(
      continueIntentAllowsLogoSwap({ ...base, targets: ["logo"] }),
      true,
    );
    assert.equal(continueIntentAllowsLogoSwap(base), false);
  });

  it("token churn allowed for adoptTheme or palette/tokens target", () => {
    assert.equal(
      continueIntentAllowsTokenChurn({ ...base, adoptTheme: true }),
      true,
    );
    assert.equal(
      continueIntentAllowsRedesign({ ...base, reuseProjectDesign: true }),
      true,
    );
    assert.equal(
      continueIntentAllowsTokenChurn({ ...base, targets: ["palette"] }),
      true,
    );
    assert.equal(continueIntentAllowsTokenChurn(base), false);
  });

  it("nav touch allowed for navAlign/nav/dashboard/landing", () => {
    assert.equal(continueIntentMayTouchNav({ ...base, navAlign: true }), true);
    assert.equal(continueIntentMayTouchNav({ ...base, targets: ["nav"] }), true);
    assert.equal(
      continueIntentMayTouchNav({ ...base, targets: ["dashboard"] }),
      true,
    );
    assert.equal(continueIntentMayTouchNav(base), false);
  });

  it("hero touch allowed for hero/copy/landing targets or redesign", () => {
    assert.equal(continueIntentMayTouchHero({ ...base, targets: ["hero"] }), true);
    assert.equal(continueIntentMayTouchHero({ ...base, targets: ["copy"] }), true);
    assert.equal(continueIntentMayTouchHero({ ...base, adoptTheme: true }), true);
    assert.equal(continueIntentMayTouchHero({ ...base, inventLogo: true }), true);
    assert.equal(continueIntentMayTouchHero(base), false);
  });

  it("continueIntentAllowsRedesign for adoptTheme/inventLogo/theme scopes", () => {
    assert.equal(continueIntentAllowsRedesign({ ...base, adoptTheme: true }), true);
    assert.equal(continueIntentAllowsRedesign({ ...base, inventLogo: true }), true);
    assert.equal(
      continueIntentAllowsRedesign({ ...base, scope: "adopt_theme" }),
      true,
    );
    assert.equal(
      continueIntentAllowsRedesign({ ...base, scope: "logo_invent" }),
      true,
    );
    assert.equal(continueIntentAllowsRedesign(base), false);
  });

  it("fallback theme+logo ask sets preserveChrome false", () => {
    const intent = fallbackContinueIntentFromText(
      "pull in the theming and design from the JamRoast project and generate a new logo in a circular symbolic manner",
    );
    assert.equal(intent.adoptTheme, true);
    assert.equal(intent.inventLogo, true);
    assert.equal(intent.preserveChrome, false);
    assert.equal(continueIntentAllowsRedesign(intent), true);
  });

  it("shell touch allowed for shell/dashboard targets", () => {
    assert.equal(continueIntentMayTouchShell({ ...base, targets: ["shell"] }), true);
    assert.equal(
      continueIntentMayTouchShell({ ...base, targets: ["dashboard"] }),
      true,
    );
    assert.equal(continueIntentMayTouchShell(base), false);
  });
});
