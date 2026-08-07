import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  acceptDesignLoop,
  bindAcceptedDesignLoopToPhase,
  createDesignLoopMeta,
  formatAcceptancePromptBlock,
  mergeAcceptanceFeatures,
  phaseDescriptionFromDesignAccept,
  preservableAcceptedFeatureIdsForScope,
  readDesignLoopAcceptance,
  readDesignLoopMeta,
  resolveDesignImplementInScope,
  seedDesignLoopAcceptanceFromHtml,
  uiSpecFromDesignLoopMock,
  writeDesignLoopAcceptance,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";
import {
  compileDesignPackFromAccept,
  formatDesignPackPromptBlock,
  readDesignLoopPack,
} from "./design-pack.js";
import {
  applyContinueIntentToScope,
  defaultProductScope,
  packHasThemeModes,
} from "./design-conceptual-model.js";
import type { ContinueIntent } from "./continue-intent.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const DUAL_THEME_HTML = `<!DOCTYPE html>
<html data-theme="dark">
<head><style>
:root { --background:#0A0A0A; --foreground:#F5F0E8; }
[data-theme="light"] { --background:#FDF8F3; --foreground:#1A1510; }
</style></head>
<body>
<header data-section="shell">Shell</header>
<section data-section="landing" data-label="Landing">Landing</section>
<section data-section="dashboard" data-label="Dashboard">Dash</section>
<img src="logo.png" alt="logo" />
<button class="theme-toggle">Dark / Light</button>
</body></html>`;

describe("design-loop delta scope (V2 full → V5 logo extension)", () => {
  it("resolveDesignImplementInScope strips preserved prior ticks when new ids added", () => {
    const r = resolveDesignImplementInScope({
      acceptedFeatureIds: [
        "theme_modes",
        "screen_landing",
        "screen_dashboard",
        "focus_logo",
      ],
      lastImplementedFeatureIds: [
        "theme_modes",
        "screen_landing",
        "screen_dashboard",
      ],
    });
    assert.deepEqual(r.inScope, ["focus_logo"]);
    assert.deepEqual(r.alreadyApplied, [
      "theme_modes",
      "screen_landing",
      "screen_dashboard",
    ]);
  });

  it("resolveDesignImplementInScope trusts narrowed ticks after reset", () => {
    const r = resolveDesignImplementInScope({
      acceptedFeatureIds: ["focus_logo", "logo"],
      lastImplementedFeatureIds: [
        "theme_modes",
        "screen_landing",
        "screen_dashboard",
      ],
    });
    assert.deepEqual(r.inScope, ["focus_logo", "logo"]);
  });

  it("first implement (no lastImplemented) keeps all accepted ids", () => {
    const r = resolveDesignImplementInScope({
      acceptedFeatureIds: ["palette", "logo", "theme_modes"],
      lastImplementedFeatureIds: [],
    });
    assert.deepEqual(r.inScope, ["palette", "logo", "theme_modes"]);
    assert.deepEqual(r.alreadyApplied, []);
  });

  it("mergeAcceptanceFeatures clears out-of-scope prior ticks for component/logo", () => {
    const prior = [
      { id: "theme_modes", label: "Theme", accepted: true },
      { id: "screen_landing", label: "Landing", accepted: true },
      { id: "screen_dashboard", label: "Dashboard", accepted: true },
      { id: "logo", label: "Logo", accepted: true },
    ];
    const scope = {
      kind: "component" as const,
      focus: "logo",
      focusPaths: [] as string[],
      preserve: ["chrome", "layout"],
      source: "continue" as const,
    };
    const keep = preservableAcceptedFeatureIdsForScope(scope);
    assert.ok(keep?.has("logo"));
    assert.ok(keep?.has("focus_logo"));
    const merged = mergeAcceptanceFeatures(
      [{ id: "focus_logo", label: "Component — logo", accepted: false }],
      prior,
      { scope, preserveAcceptedIds: keep },
    );
    const byId = Object.fromEntries(merged.map((f) => [f.id, f.accepted]));
    assert.equal(byId.theme_modes, false);
    assert.equal(byId.screen_landing, false);
    assert.equal(byId.screen_dashboard, false);
    assert.equal(byId.logo, true);
    assert.equal(byId.focus_logo, true);
  });

  it("applyContinueIntentToScope narrows assets_only / inventLogo to component logo", () => {
    const prior = defaultProductScope("start");
    const intent: ContinueIntent = {
      scope: "assets_only",
      targets: ["logo"],
      wantsAssetEdit: true,
      assetOps: ["derive_icon_pack"],
      inventLogo: false,
      inventLogoCount: 1,
      adoptTheme: false,
      reuseProjectDesign: false,
      freshDesign: false,
      replaceDesignFacets: [],
      adoptChrome: false,
      navAlign: false,
      preserveChrome: true,
      notes: "icon pack",
    };
    const next = applyContinueIntentToScope(prior, intent, "generate 4 more circular icons");
    assert.equal(next.kind, "component");
    assert.equal(next.focus, "logo");

    const invent = applyContinueIntentToScope(
      prior,
      {
        ...intent,
        scope: "sections",
        inventLogo: true,
        wantsAssetEdit: false,
      },
      "invent a new logo mark",
    );
    assert.equal(invent.kind, "component");
    assert.equal(invent.focus, "logo");
  });

  it("phaseDescriptionFromDesignAccept prefers request + delta for extensions", () => {
    const desc = phaseDescriptionFromDesignAccept({
      request: "Generate 4 more circular icon alternatives for the mark",
      briefFallback:
        "Restyle JamPress landing + dashboard with jamroast-components theme",
      inScopeIds: ["focus_logo", "logo"],
      features: [
        { id: "focus_logo", label: "Component — logo", accepted: true },
        { id: "logo", label: "Logo / mark", accepted: true },
      ],
      isExtensionImplement: true,
    });
    assert.match(desc, /circular icon/i);
    assert.match(desc, /focus_logo|logo/i);
    assert.doesNotMatch(desc, /Restyle JamPress landing/);
  });

  it("seed + accept + pack + bind: V5 logo-only after V2 implement", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-delta-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "jampress",
      brief: "Restyle landing + dashboard with full theme",
    });
    writeDesignLoopMeta(root, {
      ...meta,
      scope: {
        kind: "product",
        focus: "site",
        focusPaths: [],
        preserve: [],
        source: "start",
      },
    });
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 2,
      html: DUAL_THEME_HTML,
      notes: "v2 full",
      request: meta.brief,
      usedScaffold: false,
      parentVersion: null,
    });
    writeDesignLoopMeta(root, {
      ...readDesignLoopMeta(root, meta.id)!,
      currentVersion: 2,
    });

    writeDesignLoopAcceptance(root, meta.id, {
      version: 2,
      features: [
        { id: "theme_modes", label: "Theme modes", accepted: true },
        { id: "screen_landing", label: "Landing", accepted: true },
        { id: "screen_dashboard", label: "Dashboard", accepted: true },
        { id: "logo", label: "Logo", accepted: false },
      ],
      acceptedAt: new Date().toISOString(),
    });
    acceptDesignLoop(root, meta.id, 2, {
      acceptedFeatureIds: [
        "theme_modes",
        "screen_landing",
        "screen_dashboard",
      ],
    });
    mkdirSync(join(root, ".slopcontrol", "phases", "58-full"), {
      recursive: true,
    });
    const boundV2 = bindAcceptedDesignLoopToPhase({
      projectRoot: root,
      loopId: meta.id,
      phaseId: "58-full",
    });
    assert.ok(boundV2.inScope.includes("theme_modes"));
    assert.ok(boundV2.inScope.includes("screen_landing"));
    const afterV2 = readDesignLoopMeta(root, meta.id)!;
    assert.equal(afterV2.lastImplementedVersion, 2);
    assert.ok(afterV2.lastImplementedFeatureIds?.includes("theme_modes"));

    // Reopen + logo continue scope
    writeDesignLoopMeta(root, {
      ...afterV2,
      status: "open",
      scope: {
        kind: "component",
        focus: "logo",
        focusPaths: [],
        preserve: ["chrome", "layout", "nav", "shell"],
        source: "continue",
      },
    });
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 5,
      html: DUAL_THEME_HTML,
      notes: "v5 logo pack",
      request: "Generate 4 more circular icon alternatives",
      usedScaffold: false,
      parentVersion: 2,
    });
    writeDesignLoopMeta(root, {
      ...readDesignLoopMeta(root, meta.id)!,
      currentVersion: 5,
    });

    const seeded = seedDesignLoopAcceptanceFromHtml({
      projectRoot: root,
      loopId: meta.id,
      version: 5,
      html: DUAL_THEME_HTML,
    });
    assert.equal(
      seeded.features.find((f) => f.id === "theme_modes")?.accepted,
      false,
    );
    assert.equal(
      seeded.features.find((f) => f.id === "screen_landing")?.accepted,
      false,
    );
    assert.equal(
      seeded.features.find((f) => f.id === "screen_dashboard")?.accepted,
      false,
    );
    const logoish = seeded.features.filter(
      (f) => f.id === "logo" || f.id === "focus_logo",
    );
    assert.ok(logoish.some((f) => f.accepted));

    acceptDesignLoop(root, meta.id, 5, {
      acceptedFeatureIds: ["logo", "focus_logo"],
    });
    // Ensure focus_logo exists on acceptance for pack
    const acc = readDesignLoopAcceptance(root, meta.id)!;
    if (!acc.features.some((f) => f.id === "focus_logo")) {
      writeDesignLoopAcceptance(root, meta.id, {
        ...acc,
        features: [
          ...acc.features,
          { id: "focus_logo", label: "Component — logo", accepted: true },
        ],
      });
    } else {
      writeDesignLoopAcceptance(root, meta.id, {
        ...acc,
        features: acc.features.map((f) => ({
          ...f,
          accepted: f.id === "logo" || f.id === "focus_logo",
        })),
      });
    }

    const pack = compileDesignPackFromAccept({
      projectRoot: root,
      loopId: meta.id,
      version: 5,
      acceptance: readDesignLoopAcceptance(root, meta.id)!,
      meta: readDesignLoopMeta(root, meta.id),
    });
    assert.ok(
      pack.inScope.every((id) => id === "logo" || id === "focus_logo"),
      `expected logo-only inScope, got ${pack.inScope.join(",")}`,
    );
    assert.ok(pack.alreadyApplied?.includes("theme_modes"));
    assert.equal(packHasThemeModes(pack), false);
    assert.equal(pack.theme, undefined);
    assert.match(formatDesignPackPromptBlock(pack), /alreadyApplied/);
    assert.doesNotMatch(
      formatDesignPackPromptBlock(pack),
      /theme\.lightTokensCss/,
    );

    const acceptanceBlock = formatAcceptancePromptBlock(
      readDesignLoopAcceptance(root, meta.id),
      {
        inScopeIds: pack.inScope,
        alreadyAppliedIds: pack.alreadyApplied,
      },
    );
    assert.match(acceptanceBlock, /IN SCOPE/);
    assert.match(acceptanceBlock, /ALREADY APPLIED/);
    assert.match(acceptanceBlock, /theme_modes/);

    const ui = uiSpecFromDesignLoopMock({
      brief: phaseDescriptionFromDesignAccept({
        request: "Generate 4 more circular icon alternatives",
        briefFallback: meta.brief,
        inScopeIds: pack.inScope,
        isExtensionImplement: true,
      }),
      loopId: meta.id,
      version: 5,
      acceptance: {
        version: 5,
        features: pack.inScope.map((id) => ({
          id,
          label: id,
          accepted: true,
        })),
      },
      theme: {
        mechanism: "data-theme",
        defaultMode: "dark",
        modes: ["dark", "light"],
        togglePresent: true,
        requirements: ["wire data-theme"],
        lightTokensCss: "[data-theme=light]{}",
        darkTokensCss: ":root{}",
      },
    });
    assert.match(ui, /OUT OF SCOPE for this accept — do not add a dual-mode/);
    assert.match(ui, /circular icon/i);

    mkdirSync(join(root, ".slopcontrol", "phases", "59-logo"), {
      recursive: true,
    });
    writeDesignLoopMeta(root, {
      ...readDesignLoopMeta(root, meta.id)!,
      status: "accepted",
      acceptedVersion: 5,
    });
    const boundV5 = bindAcceptedDesignLoopToPhase({
      projectRoot: root,
      loopId: meta.id,
      phaseId: "59-logo",
    });
    assert.deepEqual(
      boundV5.inScope.filter((id) => id !== "logo" && id !== "focus_logo"),
      [],
    );
    const loopPack = readDesignLoopPack(root, meta.id);
    assert.ok(loopPack);
    assert.equal(packHasThemeModes(loopPack), false);
    const metaAfter = readDesignLoopMeta(root, meta.id)!;
    assert.equal(metaAfter.lastImplementedVersion, 5);
    assert.ok(metaAfter.lastImplementedFeatureIds?.includes("theme_modes"));
  });

  it("packHasThemeModes requires theme_modes in inScope", () => {
    assert.equal(
      packHasThemeModes({
        theme: {
          mechanism: "data-theme",
          defaultMode: "dark",
          modes: ["dark", "light"],
          togglePresent: true,
          requirements: [],
          lightTokensCss: "",
          darkTokensCss: "",
        },
        inScope: ["logo"],
        shell: ["Support dark and light mode (theme toggle)."],
      }),
      false,
    );
    assert.equal(
      packHasThemeModes({ inScope: ["theme_modes", "logo"] }),
      true,
    );
  });
});
