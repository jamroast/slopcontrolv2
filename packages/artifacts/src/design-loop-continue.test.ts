import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDesignLoopContinueAsk,
  detectMockDrift,
  dominantMockLogoAsset,
  patchMockForAssetContinue,
} from "./design-loop-continue.js";
import {
  ContinueIntentSchema,
  fallbackContinueIntentFromText,
} from "./continue-intent.js";

describe("design-loop-continue", () => {
  it("classifies icon pack ask as asset_only", () => {
    const m = classifyDesignLoopContinueAsk(
      "Please regenerate the icon pack now that the alpha channel is correct",
    );
    assert.equal(m.kind, "asset_only");
    assert.equal(m.assetEdit, true);
  });

  it("does not treat 'do not change hero' as a landing section ask", () => {
    const m = classifyDesignLoopContinueAsk(
      "Keep the v7 layout and copy. Derive icon pack from ember-monogram-alpha.png only. Do not change hero or shell.",
    );
    assert.equal(m.kind, "asset_only");
    assert.equal(m.preserveLayout, true);
    assert.deepEqual(m.sections, []);
  });

  it("classifies icon pack + tasting room as section_touch", () => {
    const m = classifyDesignLoopContinueAsk(
      "Please regenerate the icon pack. Also investigate the tasting room styling",
    );
    assert.equal(m.kind, "section_touch");
    assert.ok(m.sections.includes("tasting-room"));
    assert.equal(m.assetEdit, true);
  });

  it("classifies redesign as full_revise", () => {
    const m = classifyDesignLoopContinueAsk("redesign the whole landing from scratch");
    assert.equal(m.kind, "full_revise");
  });

  it("dominantMockLogoAsset prefers mark over icon tiles", () => {
    const html = `
<img src=".slopcontrol/design-loops/x/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/x/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/x/assets/icon-v7-16.png">
<img src=".slopcontrol/design-loops/x/assets/icon-v7-32.png">
`;
    assert.equal(dominantMockLogoAsset(html), "ember-monogram-alpha.png");
  });

  it("detectMockDrift catches hero + logo swap on asset_only", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--brand-orange:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style>
<section id="brand"></section><section id="icon-pack"></section><section id="landing"></section>
<img src=".slopcontrol/design-loops/L/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/ember-monogram-alpha.png">
<h1>Craft Roasting, Precision Controlled</h1></html>`;
    const next = `<!DOCTYPE html><html><style>:root{--brand-orange:#E8430A;--other:#111;}</style>
<section id="new"></section>
<img src=".slopcontrol/design-loops/L/assets/jamroast-ember-monogram-alpha-v7.png">
<img src=".slopcontrol/design-loops/L/assets/jamroast-ember-monogram-alpha-v7.png">
<h1>Build agents with warm-craft precision</h1></html>`;
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      mode: {
        kind: "asset_only",
        assetEdit: true,
        sections: [],
        preserveLayout: true,
        navAlign: false,
      },
      pinnedLogoAsset: "ember-monogram-alpha.png",
    });
    assert.ok(issues.some((i) => i.code === "hero_changed"));
    assert.ok(issues.some((i) => i.code === "logo_swapped"));
  });

  it("classifies align menu with code as nav_align", () => {
    const m = classifyDesignLoopContinueAsk(
      "That looks good, the menu items do not align with what exists today. Could you please align with what we have today in the code",
    );
    assert.equal(m.kind, "nav_align");
    assert.equal(m.navAlign, true);
    assert.equal(m.preserveLayout, true);
  });

  it("nav_align wins over icon-pack asset_only short-circuit", () => {
    const m = classifyDesignLoopContinueAsk(
      "Keep the v7 layout. Derive icon pack. But please align the menu items with what is in place today",
    );
    assert.equal(m.kind, "nav_align");
    assert.equal(m.assetEdit, true);
  });

  it("detectMockDrift catches nav and shell drops", () => {
    const prev = `<!DOCTYPE html><html>
<header><ul class="topbar-nav">
<li><a href="#">Dashboard</a></li><li><a href="#">Roasts</a></li>
<li><a href="#">Inventory</a></li><li><a href="#">Settings</a></li>
</ul></header>
<div class="dashboard-shell"><aside class="dash-sidebar">x</aside></div>
<h1>Craft Roasting</h1></html>`;
    const next = `<!DOCTYPE html><html>
<header><ul class="topbar-nav">
<li><a href="#">Dashboard</a></li><li><a href="#">Services</a></li>
<li><a href="#">Process</a></li>
</ul></header>
<h1>Craft Roasting</h1></html>`;
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      mode: {
        kind: "asset_only",
        assetEdit: true,
        sections: [],
        preserveLayout: true,
        navAlign: false,
      },
    });
    assert.ok(issues.some((i) => i.code === "nav_changed"));
    assert.ok(issues.some((i) => i.code === "shell_dropped"));
  });

  it("detectMockDrift allows nav change on nav_align", () => {
    const prev = `<ul class="topbar-nav"><li><a>Dashboard</a></li><li><a>Roasts</a></li></ul>
<div class="dashboard-shell"></div><h1>Craft</h1>`;
    const next = `<ul class="topbar-nav"><li><a>Services</a></li><li><a>Work</a></li></ul>
<div class="dashboard-shell"></div><h1>Craft</h1>`;
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      mode: {
        kind: "nav_align",
        assetEdit: false,
        sections: ["nav"],
        preserveLayout: true,
        navAlign: true,
      },
    });
    assert.ok(!issues.some((i) => i.code === "nav_changed"));
  });

  it("fallbackContinueIntentFromText detects new logo ask", () => {
    const intent = fallbackContinueIntentFromText(
      "Pull the JamRoast theming from /Users/x/Projects/burntjam and invent a new symbolic logo",
    );
    assert.equal(intent.inventLogo, true);
    assert.equal(intent.adoptTheme, true);
    assert.ok(intent.targets.includes("logo"));
    assert.ok(intent.targets.includes("palette"));
  });

  it("detectMockDrift allows logo swap when inventLogo intent", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--brand-orange:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style>
<img src=".slopcontrol/design-loops/L/assets/jam-light-mark-v1-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/jam-light-mark-v1-alpha.png">
<h1>JamLight CRM</h1></html>`;
    const next = `<!DOCTYPE html><html><style>:root{--brand-orange:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style>
<img src=".slopcontrol/design-loops/L/assets/jamlight-circle-mark-v2-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/jamlight-circle-mark-v2-alpha.png">
<h1>JamLight CRM</h1></html>`;
    const intent = ContinueIntentSchema.parse({
      scope: "logo_invent",
      targets: ["logo"],
      wantsAssetEdit: false,
      inventLogo: true,
      adoptTheme: false,
      navAlign: false,
      preserveChrome: true,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
      pinnedLogoAsset: "jam-light-mark-v1-alpha.png",
    });
    assert.ok(!issues.some((i) => i.code === "logo_swapped"));
  });

  it("detectMockDrift allows token churn when adoptTheme intent", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--old-a:#111;--old-b:#222;--old-c:#333;--old-d:#444;--old-e:#555;--old-f:#666;--old-g:#777;--old-h:#888;}</style><h1>X</h1></html>`;
    const next = `<!DOCTYPE html><html><style>:root{--brand:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style><h1>X</h1></html>`;
    const intent = ContinueIntentSchema.parse({
      scope: "adopt_theme",
      targets: ["palette"],
      wantsAssetEdit: false,
      inventLogo: false,
      adoptTheme: true,
      navAlign: false,
      preserveChrome: true,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
    });
    assert.ok(!issues.some((i) => i.code === "tokens_dropped"));
  });

  it("detectMockDrift still rejects logo swap on assets_only intent (regression)", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--brand-orange:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style>
<section id="brand"></section><section id="icon-pack"></section><section id="landing"></section>
<img src=".slopcontrol/design-loops/L/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/ember-monogram-alpha.png">
<h1>Craft Roasting</h1></html>`;
    const next = prev.replaceAll(
      "ember-monogram-alpha.png",
      "jamroast-fake-alpha-v2.png",
    );
    const intent = ContinueIntentSchema.parse({
      scope: "assets_only",
      targets: [],
      wantsAssetEdit: true,
      inventLogo: false,
      adoptTheme: false,
      navAlign: false,
      preserveChrome: true,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
      pinnedLogoAsset: "ember-monogram-alpha.png",
    });
    assert.ok(issues.some((i) => i.code === "logo_swapped"));
  });

  it("detectMockDrift: adoptTheme allows hero change even if preserveChrome true (gates)", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--brand-orange:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style><h1>Keep Me</h1></html>`;
    const next = prev.replace("<h1>Keep Me</h1>", "<h1>Changed Hero</h1>");
    const intent = ContinueIntentSchema.parse({
      scope: "sections",
      targets: ["palette"],
      wantsAssetEdit: false,
      inventLogo: false,
      adoptTheme: true,
      navAlign: false,
      preserveChrome: true,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
    });
    assert.ok(!issues.some((i) => i.code === "hero_changed"));
  });

  it("detectMockDrift: JamRoast theme+logo redesign short-circuits all fingerprint vetoes", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--old-a:#111;--old-b:#222;--old-c:#333;--old-d:#444;--old-e:#555;--old-f:#666;--old-g:#777;--old-h:#888;}</style>
<nav><a>Dashboard</a><a>Invoices</a></nav>
<img src=".slopcontrol/design-loops/L/assets/jam-light-mark-v1-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/jam-light-mark-v1-alpha.png">
<section id="landing" class="dashboard-shell"><aside></aside></section>
<h1>Invoicing that works as hard as you do</h1></html>`;
    const next = `<!DOCTYPE html><html><style>:root{--brand:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style>
<nav><a>Home</a><a>Work</a></nav>
<img src=".slopcontrol/design-loops/L/assets/jamlight-circle-mark-v2-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/jamlight-circle-mark-v2-alpha.png">
<section id="landing" class="dashboard-shell"><aside></aside></section>
<h1>Invoicing and CRM, in one ledger.</h1></html>`;
    const intent = ContinueIntentSchema.parse({
      scope: "adopt_theme",
      targets: ["logo", "palette", "landing"],
      wantsAssetEdit: false,
      inventLogo: true,
      adoptTheme: true,
      navAlign: false,
      preserveChrome: false,
      notes: "Pull JamRoast theme and invent a circular JamLight mark",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
      pinnedLogoAsset: "jam-light-mark-v1-alpha.png",
    });
    assert.deepEqual(issues, []);
  });

  it("detectMockDrift still rejects unintended hero change on assets_only", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--brand-orange:#E8430A;--bg:#000;--fg:#fff;--sf:#111;--bd:#222;--radius-md:8px;--font-body:Inter;--fs-body:1rem;}</style>
<section id="brand"></section><section id="icon-pack"></section><section id="landing"></section>
<img src=".slopcontrol/design-loops/L/assets/ember-monogram-alpha.png">
<h1>Keep Me</h1></html>`;
    const next = prev.replace("<h1>Keep Me</h1>", "<h1>Changed Hero</h1>");
    const intent = ContinueIntentSchema.parse({
      scope: "assets_only",
      targets: [],
      wantsAssetEdit: true,
      inventLogo: false,
      adoptTheme: false,
      navAlign: false,
      preserveChrome: true,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
    });
    assert.ok(issues.some((i) => i.code === "hero_changed"));
  });

  it("patchMockForAssetContinue swaps fake alpha and icon pack tiles", () => {
    const loopId = "loop-1";
    const prev = `
<img src=".slopcontrol/design-loops/${loopId}/assets/jamroast-ember-monogram-alpha-v7.png">
<img src=".slopcontrol/design-loops/${loopId}/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/${loopId}/assets/icon-v7-32.png">
<img src=".slopcontrol/design-loops/${loopId}/assets/icon-v7-512.png">
`;
    const out = patchMockForAssetContinue({
      previousHtml: prev,
      loopId,
      primaryLogoAsset: "ember-monogram-alpha.png",
      iconPackFiles: [
        { size: 32, filename: "icon-v9-32.png" },
        { size: 512, filename: "icon-v9-512.png" },
      ],
    });
    assert.match(out, /ember-monogram-alpha\.png/);
    assert.doesNotMatch(out, /jamroast-ember-monogram-alpha-v7/);
    assert.match(out, /icon-v9-32\.png/);
    assert.match(out, /icon-v9-512\.png/);
  });

  it("patchMockForAssetContinue replaces jam-light-mark-v1 with modern primary", () => {
    const loopId = "6cfc01ed-36ab-44ae-bb59-b7ea60aef062";
    const prev = `<!DOCTYPE html><html><body>
<img src=".slopcontrol/design-loops/${loopId}/assets/jam-light-mark-v1-alpha.png">
<img src=".slopcontrol/design-loops/${loopId}/assets/jam-light-mark-v1-alpha.png">
<img src=".slopcontrol/design-loops/${loopId}/assets/modern-icon-48.png">
</body></html>`;
    const out = patchMockForAssetContinue({
      previousHtml: prev,
      loopId,
      primaryLogoAsset: "jamlight-logo-modern-v4-alpha.png",
    });
    assert.match(out, /jamlight-logo-modern-v4-alpha\.png/);
    assert.doesNotMatch(out, /jam-light-mark-v1-alpha/);
    // Icon pack tiles are left alone unless iconPackFiles is provided.
    assert.match(out, /modern-icon-48\.png/);
  });
});
