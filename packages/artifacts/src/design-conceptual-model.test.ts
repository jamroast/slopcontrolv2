import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  acceptDesignLoop,
  bindAcceptedDesignLoopToPhase,
  createDesignLoopMeta,
  extractTokensCssFromHtml,
  mergeAcceptanceFeatures,
  uiSpecFromDesignLoopMock,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";
import {
  classifyDesignScopeFromText,
  checkThemeContractInProject,
  extractThemeContractFromHtml,
  extractThemeTokenBlocks,
  fallbackFeaturesForScope,
  formatConceptualModelPromptBlock,
  summarizeConceptualModel,
} from "./design-conceptual-model.js";
import {
  compileDesignPackFromAccept,
  formatDesignPackPromptBlock,
} from "./design-pack.js";
import { fallbackContinueIntentFromText } from "./continue-intent.js";

const DUAL_THEME_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head><style>
:root {
  --background: #0A0A0A;
  --surface: #151515;
  --foreground: #F5F0E8;
  --accent: #E8430A;
}
[data-theme="light"] {
  --background: #FDF8F3;
  --surface: #F5EDE3;
  --foreground: #1A1510;
}
</style></head>
<body>
<button class="theme-toggle"><span data-theme-val="dark">Dark</span><span data-theme-val="light">Light</span></button>
<div class="section-label"><b>1</b> Palette — warm</div>
</body></html>`;

describe("design-conceptual-model", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("extractThemeTokenBlocks keeps dark and light CSS", () => {
    const blocks = extractThemeTokenBlocks(DUAL_THEME_HTML);
    assert.match(blocks.darkTokensCss, /--background:\s*#0A0A0A/);
    assert.match(blocks.lightTokensCss, /\[data-theme="light"\]/);
    assert.match(blocks.lightTokensCss, /--foreground:\s*#1A1510/);
    assert.match(extractTokensCssFromHtml(DUAL_THEME_HTML), /data-theme="light"/);
  });

  it("extractThemeContractFromHtml builds theme with requirements", () => {
    const theme = extractThemeContractFromHtml(DUAL_THEME_HTML, {
      request: "dark and light mode",
    });
    assert.ok(theme);
    assert.equal(theme!.mechanism, "data-theme");
    assert.ok(theme!.modes.includes("light"));
    assert.equal(theme!.togglePresent, true);
    assert.ok(theme!.requirements.length >= 3);
  });

  it("classifyDesignScopeFromText: chat form → component", () => {
    const scope = classifyDesignScopeFromText(
      "Please work only on the chat form in the agent panel",
    );
    assert.equal(scope.kind, "component");
    assert.match(scope.focus, /form|chat/i);
    assert.ok(scope.preserve.includes("palette") || scope.preserve.includes("chrome"));
  });

  it("classifyDesignScopeFromText: theme toggle → shell", () => {
    const scope = classifyDesignScopeFromText(
      "Add dark and light theme toggle on the menubar",
    );
    assert.equal(scope.kind, "shell");
    assert.match(scope.focus, /theme|menubar/i);
  });

  it("fallbackFeaturesForScope differs for component vs product", () => {
    const product = fallbackFeaturesForScope(
      { kind: "product", focus: "site", focusPaths: [], preserve: [], source: "start" },
      { includeThemeModes: true },
    );
    const component = fallbackFeaturesForScope({
      kind: "component",
      focus: "chat.composer",
      focusPaths: [],
      preserve: ["chrome"],
      source: "start",
    });
    assert.ok(product.some((f) => f.id === "applied_shell"));
    assert.ok(product.some((f) => f.id === "theme_modes"));
    assert.ok(component.some((f) => f.id.startsWith("focus_")));
    assert.equal(
      component.some((f) => f.id === "applied_shell"),
      false,
    );
  });

  it("mergeAcceptanceFeatures is scope-aware for component", () => {
    const merged = mergeAcceptanceFeatures([], null, {
      scope: {
        kind: "component",
        focus: "chat.composer",
        focusPaths: [],
        preserve: ["chrome"],
        source: "start",
      },
    });
    assert.ok(merged.some((f) => f.id.startsWith("focus_")));
    assert.equal(merged.some((f) => f.id === "palette"), false);
  });

  it("compileDesignPackFromAccept includes theme + scope; UI-SPEC Theme section", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-cm-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "Dark and light mode on the shell",
    });
    assert.equal(meta.scope?.kind, "shell");
    writeDesignLoopMeta(root, meta);
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: DUAL_THEME_HTML,
      notes: "toggle works",
      request: "dark and light",
    });

    const pack = compileDesignPackFromAccept({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      acceptance: {
        version: 1,
        features: [
          { id: "theme_modes", label: "Theme", accepted: true },
          { id: "applied_shell", label: "Shell", accepted: true },
          { id: "palette", label: "Palette", accepted: false },
        ],
      },
      meta,
    });
    assert.ok(pack.theme);
    assert.match(pack.tokens, /data-theme="light"/);
    assert.ok(pack.scope);
    const block = formatDesignPackPromptBlock(pack);
    assert.match(block, /CONCEPTUAL MODEL|conceptual model/i);
    assert.match(block, /theme\.lightTokensCss|light tokens/i);

    const ui = uiSpecFromDesignLoopMock({
      brief: meta.brief,
      loopId: meta.id,
      version: 1,
      acceptance: {
        version: 1,
        features: [
          { id: "theme_modes", label: "Theme", accepted: true },
          { id: "applied_shell", label: "Shell", accepted: true },
        ],
      },
      scope: pack.scope,
      theme: pack.theme,
    });
    assert.match(ui, /## Theme/);
    assert.match(ui, /## Scope/);
    assert.match(ui, /data-theme/);
    assert.match(ui, /Visibility \(mandatory when togglePresent\)/);
    assert.match(ui, /@source|style emission|text-text-secondary/);
    assert.match(ui, /visible/);
  });

  it("bind writes phase tokens.css with light block", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-cm-bind-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "Theme modes",
    });
    writeDesignLoopMeta(root, meta);
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: DUAL_THEME_HTML,
      notes: "ok",
      request: "dark light",
    });
    acceptDesignLoop(root, meta.id, 1, {
      acceptedFeatureIds: ["theme_modes", "applied_shell", "palette"],
    });
    mkdirSync(join(root, ".slopcontrol", "phases", "01-theme"), {
      recursive: true,
    });
    bindAcceptedDesignLoopToPhase({
      projectRoot: root,
      loopId: meta.id,
      phaseId: "01-theme",
    });
    const tokens = readFileSync(
      join(root, ".slopcontrol", "phases", "01-theme", "design", "tokens.css"),
      "utf-8",
    );
    assert.match(tokens, /\[data-theme="light"\]/);
    const ui = readFileSync(
      join(root, ".slopcontrol", "phases", "01-theme", "UI-SPEC.md"),
      "utf-8",
    );
    assert.match(ui, /## Theme/);
  });

  it("fallbackContinueIntent sets designScope for chat form", () => {
    const intent = fallbackContinueIntentFromText(
      "Please only change the chat composer form",
    );
    assert.ok(intent.designScope);
    assert.equal(intent.designScope!.kind, "component");
  });

  it("formatConceptualModelPromptBlock includes mock scope guidance", () => {
    const block = formatConceptualModelPromptBlock({
      scope: {
        kind: "component",
        focus: "chat.composer",
        focusPaths: [],
        preserve: ["chrome"],
        source: "continue",
      },
      forMock: true,
    });
    assert.match(block, /CONCEPTUAL MODEL/);
    assert.match(block, /ghost chrome|out of scope/i);
  });

  it("checkThemeContractInProject warns on dark-only body", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-theme-check-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "globals.css"),
      `body { background: var(--color-dark-base); color: #fff; }\n`,
    );
    const theme = extractThemeContractFromHtml(DUAL_THEME_HTML)!;
    const check = checkThemeContractInProject({ projectRoot: root, theme });
    assert.equal(check.ok, false);
    assert.ok(check.issues.length >= 1);
  });

  it("summarizeConceptualModel shapes API summary", () => {
    const summary = summarizeConceptualModel({
      scope: {
        kind: "shell",
        focus: "theme",
        focusPaths: [],
        preserve: ["logo"],
        source: "start",
      },
      theme: extractThemeContractFromHtml(DUAL_THEME_HTML),
      inScope: ["theme_modes"],
    });
    assert.equal(summary.kind, "shell");
    assert.equal(summary.focus, "theme");
    assert.deepEqual(summary.inScope, ["theme_modes"]);
    assert.ok(summary.theme?.modes.includes("light"));
  });
});
