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
  detectDesignAssetOpsFromText,
  extractInventLogoCountFromText,
  fallbackContinueIntentFromText,
  formatContinueIntentPromptBlock,
  normalizeContinueIntentStructured,
  textSignalsMenubarContentAlign,
  textSignalsReuseProjectDesign,
} from "./continue-intent.js";

describe("continue-intent schema", () => {
  it("applies defaults for omitted fields", () => {
    const intent = ContinueIntentSchema.parse({ scope: "sections" });
    assert.deepEqual(intent.targets, []);
    assert.equal(intent.wantsAssetEdit, false);
    assert.deepEqual(intent.assetOps, []);
    assert.equal(intent.inventLogo, false);
    assert.equal(intent.inventLogoCount, 1);
    assert.equal(intent.adoptTheme, false);
    assert.equal(intent.reuseProjectDesign, false);
    assert.equal(intent.adoptChrome, false);
    assert.equal(intent.navAlign, false);
    assert.equal(intent.preserveChrome, false);
    assert.equal(intent.notes, "");
  });

  it("detectDesignAssetOpsFromText orders transparent before icon pack", () => {
    assert.deepEqual(
      detectDesignAssetOpsFromText(
        "cut out the logo with alpha channel and make an icon pack",
      ),
      ["make_transparent", "derive_icon_pack"],
    );
    assert.deepEqual(
      detectDesignAssetOpsFromText("regenerate the icon pack only"),
      ["derive_icon_pack"],
    );
  });

  it("detectDesignAssetOpsFromText prefers circular_mask for circular cut-out", () => {
    assert.deepEqual(
      detectDesignAssetOpsFromText("cut out the circular logo."),
      ["circular_mask"],
    );
  });

  it("detectDesignAssetOpsFromText chains chroma + circular + pack", () => {
    assert.deepEqual(
      detectDesignAssetOpsFromText(
        "cut out the circular logo with an alpha channel and create an icon pack",
      ),
      ["make_transparent", "circular_mask", "derive_icon_pack"],
    );
  });

  it("coerces inventLogoCount 0/null to 1 (LLM often sends 0 when not inventing)", () => {
    assert.equal(
      ContinueIntentSchema.parse({ scope: "sections", inventLogoCount: 0 })
        .inventLogoCount,
      1,
    );
    assert.equal(
      ContinueIntentSchema.parse({ scope: "sections", inventLogoCount: null })
        .inventLogoCount,
      1,
    );
    assert.equal(
      ContinueIntentSchema.parse({ scope: "sections", inventLogoCount: 99 })
        .inventLogoCount,
      12,
    );
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
    assert.ok(intent.assetOps.includes("make_transparent"));
    assert.ok(intent.assetOps.includes("derive_icon_pack"));
  });

  it("JamPress cut-out + alpha + icon pack is asset recipe, not invent", () => {
    const ask =
      "Perfect, thanks. I need you to please cut out the logo. A the moment the logo has a black background that is appearing on the light mode. This creates a black square, please cut out the circular logo from the image and produce and update logo with an alpha channel. I need you to also create an icon pack that can be used by the browser as an icon using this newly updated logo";
    const intent = fallbackContinueIntentFromText(ask);
    assert.equal(intent.inventLogo, false);
    assert.equal(intent.wantsAssetEdit, true);
    assert.deepEqual(intent.assetOps, [
      "make_transparent",
      "circular_mask",
      "derive_icon_pack",
    ]);
    assert.equal(intent.scope, "assets_only");
  });

  it("soft change-the-logo alone still invents", () => {
    const intent = fallbackContinueIntentFromText("Please change the logo");
    assert.equal(intent.inventLogo, true);
    assert.equal(intent.wantsAssetEdit, false);
    assert.deepEqual(intent.assetOps, []);
  });

  it("normalize prefers asset recipe over invent when both are set", () => {
    // Edit-first when both present (compound ask safety).
    const editFirst = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "logo_invent",
        targets: ["logo"],
        inventLogo: true,
        wantsAssetEdit: true,
        assetOps: ["make_transparent", "derive_icon_pack"],
        preserveChrome: false,
        notes: "",
      }),
    );
    assert.equal(editFirst.inventLogo, false);
    assert.deepEqual(editFirst.assetOps, [
      "make_transparent",
      "derive_icon_pack",
    ]);
    assert.equal(editFirst.wantsAssetEdit, true);
    assert.equal(editFirst.scope, "assets_only");
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

  it("classifies centre menubar with page content as shell layout, not navAlign", () => {
    const ask =
      "That is looking good, but what we really need is to centre the menu bar contents for the landing page over the contents in the page, make sure they use the same width as the contents on the page. Please also make the logo and menu items left align and the sign in and day night toggle right align";
    assert.equal(textSignalsMenubarContentAlign(ask), true);
    const intent = fallbackContinueIntentFromText(ask);
    assert.equal(intent.navAlign, false);
    assert.ok(intent.targets.includes("shell"));
    assert.ok(intent.targets.includes("layout"));
    assert.notEqual(intent.scope, "nav_align");
    assert.equal(intent.designScope?.kind, "shell");
    assert.equal(intent.designScope?.focus, "menubar");
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

  it("offline fallback: using jamroast-components sets adoptTheme + shareFrom", () => {
    const intent = fallbackContinueIntentFromText(
      "Please create a new mock using jamroast-components and show landing and dashboard",
    );
    assert.equal(intent.adoptTheme, true);
    assert.equal(intent.shareFrom, "jamroast-components");
    assert.ok(intent.targets.includes("landing"));
    assert.ok(intent.targets.includes("dashboard"));
  });

  it("structured normalize does not OR inventLogo from text", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "sections",
        inventLogo: false,
        notes: "I am unhappy with the logos",
      }),
    );
    assert.equal(intent.inventLogo, false);
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
      ask: "centre the menu bar contents for the landing page over the contents in the page, make sure they use the same width as the contents on the page",
      expect: { navAlign: false, scope: "sections" },
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
    assert.equal(
      continueIntentMayTouchNav({ ...base, targets: ["shell"] }),
      true,
    );
    assert.equal(
      continueIntentMayTouchNav({ ...base, targets: ["layout"] }),
      true,
    );
    assert.equal(
      continueIntentMayTouchNav({ ...base, adoptChrome: true }),
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
      continueIntentAllowsRedesign({ ...base, adoptChrome: true }),
      true,
    );
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

  it("fallback look-and-feel from sibling sets adoptChrome", () => {
    const intent = fallbackContinueIntentFromText(
      "use the look and feel from jamroast-components including menubar and theme toggle",
    );
    assert.equal(intent.adoptTheme, true);
    assert.equal(intent.adoptChrome, true);
    assert.ok(intent.targets.includes("shell"));
    assert.ok(intent.targets.includes("layout"));
    assert.equal(intent.preserveChrome, false);
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
      continueIntentMayTouchShell({ ...base, targets: ["layout"] }),
      true,
    );
    assert.equal(
      continueIntentMayTouchShell({ ...base, targets: ["dashboard"] }),
      true,
    );
    assert.equal(
      continueIntentMayTouchShell({ ...base, adoptChrome: true }),
      true,
    );
    assert.equal(continueIntentMayTouchShell(base), false);
  });
});

describe("inventLogoCount", () => {
  it("extractInventLogoCountFromText reads generate N different logos", () => {
    assert.equal(
      extractInventLogoCountFromText(
        "Please generate 7 different logos using different styles, rustic, modern, etc",
      ),
      7,
    );
    assert.equal(extractInventLogoCountFromText("make 5 circular marks"), 5);
    assert.equal(extractInventLogoCountFromText("design a new logo"), 1);
  });

  it("fallback invent with count sets inventLogoCount", () => {
    const intent = fallbackContinueIntentFromText(
      "I now need you to please design a new logo. Please make it circular and symbolic. Please generate 7 different logos using different styles",
    );
    assert.equal(intent.inventLogo, true);
    assert.equal(intent.inventLogoCount, 7);
  });

  it("normalize forces inventLogoCount to 1 when not inventing", () => {
    const intent = normalizeContinueIntentStructured(
      ContinueIntentSchema.parse({
        scope: "sections",
        inventLogo: false,
        inventLogoCount: 7,
        preserveChrome: true,
        notes: "",
      }),
    );
    assert.equal(intent.inventLogoCount, 1);
  });

  it("formatContinueIntentPromptBlock multi vs singular invent", () => {
    const multi = formatContinueIntentPromptBlock(
      ContinueIntentSchema.parse({
        scope: "logo_invent",
        inventLogo: true,
        inventLogoCount: 7,
        targets: ["logo"],
        preserveChrome: false,
        notes: "",
      }),
    );
    assert.match(multi, /NEW LOGO VARIANTS \(7\)/);
    assert.match(multi, /Do NOT call pin_logo/);
    const one = formatContinueIntentPromptBlock(
      ContinueIntentSchema.parse({
        scope: "logo_invent",
        inventLogo: true,
        inventLogoCount: 1,
        targets: ["logo"],
        preserveChrome: false,
        notes: "",
      }),
    );
    assert.match(one, /NEW LOGO:/);
    assert.match(one, /pin_logo that filename/);
  });
});
