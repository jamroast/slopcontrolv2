import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeDesignLoopVersionNotes,
  detectMockDrift,
  dominantMockLogoAsset,
  hardMockDriftIssues,
  patchMockForAssetContinue,
  sanitizeDesignLoopAgentNotes,
  softMockDriftIssues,
} from "./design-loop-continue.js";
import {
  ContinueIntentSchema,
  fallbackContinueIntentFromText,
} from "./continue-intent.js";

describe("design-loop-continue", () => {
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
      intent: ContinueIntentSchema.parse({
        scope: "assets_only",
        targets: [],
        wantsAssetEdit: true,
        inventLogo: false,
        adoptTheme: false,
        reuseProjectDesign: false,
        navAlign: false,
        preserveChrome: true,
        notes: "",
      }),
      pinnedLogoAsset: "ember-monogram-alpha.png",
    });
    assert.ok(issues.some((i) => i.code === "hero_changed"));
    assert.ok(issues.some((i) => i.code === "logo_swapped"));
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
      intent: ContinueIntentSchema.parse({
        scope: "assets_only",
        targets: [],
        wantsAssetEdit: true,
        inventLogo: false,
        adoptTheme: false,
        reuseProjectDesign: false,
        navAlign: false,
        preserveChrome: true,
        notes: "",
      }),
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
      intent: ContinueIntentSchema.parse({
        scope: "nav_align",
        targets: ["nav"],
        wantsAssetEdit: false,
        inventLogo: false,
        adoptTheme: false,
        reuseProjectDesign: false,
        navAlign: true,
        preserveChrome: true,
        notes: "",
      }),
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
      reuseProjectDesign: false,
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
      reuseProjectDesign: false,
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
      reuseProjectDesign: false,
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
    assert.ok(hardMockDriftIssues(issues).some((i) => i.code === "hero_changed"));
  });

  it("detectMockDrift: nav reorder alone is not nav_changed (JamLight menubar)", () => {
    const prev = `<!DOCTYPE html><html>
<header><ul class="topbar-nav">
<li><a href="#">Dashboard</a></li><li><a href="#">Roasts</a></li>
<li><a href="#">Inventory</a></li><li><a href="#">Settings</a></li>
</ul></header>
<div class="dashboard-shell"></div><h1>JamLight</h1></html>`;
    const next = `<!DOCTYPE html><html>
<header><ul class="topbar-nav">
<li><a href="#">Settings</a></li><li><a href="#">Inventory</a></li>
<li><a href="#">Roasts</a></li><li><a href="#">Dashboard</a></li>
</ul></header>
<div class="dashboard-shell"></div><h1>JamLight</h1></html>`;
    const intent = ContinueIntentSchema.parse({
      scope: "assets_only",
      targets: [],
      wantsAssetEdit: true,
      inventLogo: false,
      adoptTheme: false,
      reuseProjectDesign: false,
      navAlign: false,
      preserveChrome: true,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
    });
    assert.ok(!issues.some((i) => i.code === "nav_changed"));
  });

  it("detectMockDrift: shell/layout intent allows nav label set changes", () => {
    const prev = `<ul class="topbar-nav"><li><a>Dashboard</a></li><li><a>Roasts</a></li></ul>
<div class="dashboard-shell"></div><h1>JamLight</h1>`;
    const next = `<ul class="topbar-nav"><li><a>Home</a></li><li><a>Chat</a></li></ul>
<div class="dashboard-shell"></div><h1>JamLight</h1>`;
    const intent = ContinueIntentSchema.parse({
      scope: "sections",
      targets: ["shell", "layout"],
      wantsAssetEdit: false,
      inventLogo: false,
      adoptTheme: false,
      reuseProjectDesign: false,
      navAlign: false,
      preserveChrome: false,
      notes: "logo left, auth/theme right",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
    });
    assert.ok(!issues.some((i) => i.code === "nav_changed"));
  });

  it("detectMockDrift: dashboard continue hero change is soft (JamLight v7 regression)", () => {
    const prev = `<!DOCTYPE html><html>
<section id="landing" class="hero"><h1>Invoicing and CRM, in one ledger.</h1></section>
<section id="dashboard" class="dashboard"><h2>Overview</h2></section>
</html>`;
    const next = `<!DOCTYPE html><html>
<section id="landing" class="hero"><h1>Good morning, Brett</h1></section>
<section id="dashboard" class="dashboard-shell"><h1>Dashboard</h1></section>
</html>`;
    const intent = ContinueIntentSchema.parse({
      scope: "sections",
      targets: ["dashboard", "shell", "layout"],
      wantsAssetEdit: false,
      inventLogo: false,
      adoptTheme: false,
      reuseProjectDesign: false,
      navAlign: false,
      preserveChrome: false,
      notes: "mock out a full-screen dashboard",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
    });
    const hero = issues.filter((i) => i.code === "hero_changed");
    assert.ok(hero.length >= 1, "hero fingerprint still reports the landing change");
    assert.equal(hero[0]!.severity, "soft");
    assert.deepEqual(hardMockDriftIssues(issues), []);
    assert.ok(softMockDriftIssues(issues).some((i) => i.code === "hero_changed"));
  });

  it("detectMockDrift: assets_only logo swap remains hard", () => {
    const prev = `<!DOCTYPE html><html><style>:root{--a:#1;--b:#2;--c:#3;--d:#4;--e:#5;--f:#6;--g:#7;--h:#8;}</style>
<img src=".slopcontrol/design-loops/L/assets/jam-light-mark-v1-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/jam-light-mark-v1-alpha.png">
<section id="landing"><h1>Keep</h1></section></html>`;
    const next = `<!DOCTYPE html><html><style>:root{--a:#1;--b:#2;--c:#3;--d:#4;--e:#5;--f:#6;--g:#7;--h:#8;}</style>
<img src=".slopcontrol/design-loops/L/assets/other-mark-alpha.png">
<img src=".slopcontrol/design-loops/L/assets/other-mark-alpha.png">
<section id="landing"><h1>Keep</h1></section></html>`;
    const intent = ContinueIntentSchema.parse({
      scope: "assets_only",
      targets: [],
      wantsAssetEdit: true,
      inventLogo: false,
      adoptTheme: false,
      reuseProjectDesign: false,
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
    assert.ok(issues.some((i) => i.code === "logo_swapped" && i.severity === "hard"));
    assert.ok(hardMockDriftIssues(issues).some((i) => i.code === "logo_swapped"));
  });

  it("detectMockDrift: competing theme-toggle is soft when pinned (LLM honor is arbiter)", () => {
    const prev = `<header><button class="theme-toggle">Dark / Light</button><h1>X</h1></header>`;
    const next = `<header><button class="theme-toggle">Dark / Light</button><button class="theme-toggle">Also</button><h1>X</h1></header>`;
    const intent = ContinueIntentSchema.parse({
      scope: "sections",
      targets: ["dashboard"],
      wantsAssetEdit: false,
      inventLogo: false,
      adoptTheme: false,
      reuseProjectDesign: false,
      navAlign: false,
      preserveChrome: false,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
      pinnedElements: [{ id: "theme-toggle" }],
    });
    assert.ok(issues.some((i) => i.code === "element_invented" && i.severity === "soft"));
    assert.ok(!hardMockDriftIssues(issues).some((i) => i.code === "element_invented"));
  });

  it("detectMockDrift: BEM theme-toggle children are not hard invent", () => {
    const prev = `<header class="menubar"><button class="theme-toggle">T</button><h1>X</h1></header>`;
    const next = `<header class="menubar"><button class="theme-toggle"><svg class="theme-toggle__sun"></svg><svg class="theme-toggle__moon"></svg></button><h1>X</h1></header>`;
    const intent = ContinueIntentSchema.parse({
      scope: "sections",
      targets: ["landing"],
      wantsAssetEdit: false,
      inventLogo: false,
      adoptTheme: false,
      reuseProjectDesign: false,
      navAlign: false,
      preserveChrome: false,
      notes: "",
    });
    const issues = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent,
      pinnedElements: [{ id: "theme-toggle" }, { id: "menubar" }],
    });
    assert.ok(!hardMockDriftIssues(issues).some((i) => i.code === "element_invented"));
    assert.ok(!issues.some((i) => i.code === "element_invented" && i.severity === "hard"));
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

  it("sanitizeDesignLoopAgentNotes drops first-person planning prose", () => {
    assert.equal(
      sanitizeDesignLoopAgentNotes(
        "I'll apply the jamroast-components shared tokens to the landing page.",
      ),
      "",
    );
    assert.equal(
      sanitizeDesignLoopAgentNotes("Menubar centered with logo left."),
      "Menubar centered with logo left.",
    );
  });

  it("composeDesignLoopVersionNotes prefers honor and skips agent prose", () => {
    const notes = composeDesignLoopVersionNotes({
      elementHonorNotes:
        "Element honor: honors=true competing=false missingMenubar=false missingToggle=false confidence=high.",
      softDriftNotes: "",
      agentRaw:
        "I'll apply the jamroast-components shared tokens, menubar shell, theme toggle.",
      version: 8,
    });
    assert.match(notes, /Element honor/);
    assert.doesNotMatch(notes, /I'll apply/);
  });
});
