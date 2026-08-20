import assert from "node:assert/strict";
import {
  existsSync,
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
  abandonDesignLoop,
  appendDesignLoopTranscript,
  bindAcceptedDesignLoopToPhase,
  createDesignLoopMeta,
  designLoopAssetsDir,
  extractFeaturesFromMockHtml,
  extractHtmlDocument,
  extractTokensCssFromHtml,
  formatAcceptancePromptBlock,
  readDesignLoopAcceptance,
  readDesignLoopMeta,
  readDesignLoopRequest,
  readDesignLoopTranscript,
  readDesignLoopVersionMeta,
  readPhaseDesignAcceptance,
  reopenDesignLoopForIterate,
  formatDesignLoopReviseBlock,
  formatPhaseBoundMockPromptBlock,
  resolveDesignLoopGenerateFallback,
  rewriteDesignLoopAssetUrls,
  scaffoldDesignLoopMock,
  seedDesignLoopAcceptanceFromHtml,
  setDesignLoopLastError,
  uiSpecFromDesignLoopMock,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";

describe("design-loop", () => {
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

  it("extractHtmlDocument prefers fenced html", () => {
    const html = extractHtmlDocument(
      'Here you go:\n```html\n<!DOCTYPE html><html><body>Hi</body></html>\n```\n',
    );
    assert.ok(html?.includes("<!DOCTYPE html>"));
    assert.ok(html?.includes("Hi"));
  });

  it("scaffoldDesignLoopMock is self-contained", () => {
    const html = scaffoldDesignLoopMock("Match JamPress header");
    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes(":root"));
    assert.ok(html.includes("Match JamPress header"));
  });

  it("extractTokensCssFromHtml finds :root", () => {
    const css = extractTokensCssFromHtml(
      `<html><style>:root { --accent: #f00; }</style></html>`,
    );
    assert.ok(css.includes("--accent"));
  });

  it("extractFeaturesFromMockHtml maps section labels to stable ids", () => {
    const html = `<div class="section-label"><b>1</b> Palette — locked</div>
<div class="section-label"><b>2</b> Logo — glowing jam-lid</div>
<div class="section-label"><b>4</b> Applied — final frames</div>`;
    const features = extractFeaturesFromMockHtml(html);
    assert.ok(features.some((f) => f.id === "palette"));
    assert.ok(features.some((f) => f.id === "logo"));
    assert.ok(features.some((f) => f.id === "applied_shell"));
    assert.ok(features.every((f) => f.accepted === false));
  });

  it("accept requires at least one feature; bind copies ACCEPTANCE + scoped UI-SPEC", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dloop-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "Dark chrome with orange accent",
    });
    writeDesignLoopMeta(root, meta);
    const html = `<!DOCTYPE html><html><head><style>:root{--a:#f00}</style></head><body>
<div class="section-label"><b>1</b> Palette — locked</div>
<div class="section-label"><b>4</b> Applied — portal shell</div>
</body></html>`;
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html,
      notes: "v1",
      request: meta.brief,
      usedScaffold: false,
    });
    meta.currentVersion = 1;
    writeDesignLoopMeta(root, meta);
    seedDesignLoopAcceptanceFromHtml({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html,
    });

    assert.throws(
      () => acceptDesignLoop(root, meta.id, 1, { acceptedFeatureIds: [] }),
      /at least one/,
    );

    const accepted = acceptDesignLoop(root, meta.id, 1, {
      acceptedFeatureIds: ["palette", "applied_shell"],
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.acceptedVersion, 1);
    const acc = readDesignLoopAcceptance(root, meta.id);
    assert.ok(acc?.features.find((f) => f.id === "palette")?.accepted);
    assert.ok(acc?.features.find((f) => f.id === "applied_shell")?.accepted);

    const bound = bindAcceptedDesignLoopToPhase({
      projectRoot: root,
      loopId: meta.id,
      phaseId: "01-look",
    });
    assert.equal(bound.meta.status, "implemented");
    assert.equal(bound.meta.phaseId, "01-look");
    assert.ok(
      existsSync(
        join(root, ".slopcontrol/phases/01-look/design/ACCEPTANCE.json"),
      ),
    );
    const phaseAcc = readPhaseDesignAcceptance(root, "01-look");
    assert.ok(phaseAcc?.features.some((f) => f.accepted));
    const uiSpec = readFileSync(
      join(root, ".slopcontrol/phases/01-look/UI-SPEC.md"),
      "utf-8",
    );
    assert.match(uiSpec, /## Accepted features/);
    assert.match(uiSpec, /applied_shell/);
    assert.match(uiSpec, /IN SCOPE \(applied_shell\)/);

    const again = readDesignLoopMeta(root, meta.id);
    assert.equal(again?.status, "implemented");

    const reopened = reopenDesignLoopForIterate(root, meta.id);
    assert.equal(reopened.status, "open");
    assert.equal(reopened.acceptedVersion, 1);
    assert.equal(reopened.phaseId, "01-look");
  });

  it("uiSpecFromDesignLoopMock marks out-of-scope layout when shell unticked", () => {
    const spec = uiSpecFromDesignLoopMock({
      brief: "theme",
      loopId: "loop-1",
      version: 2,
      acceptance: {
        version: 2,
        features: [
          { id: "palette", label: "Palette", accepted: true },
          { id: "applied_shell", label: "Applied frames", accepted: false },
        ],
      },
    });
    assert.match(spec, /OUT OF SCOPE \(applied_shell not accepted\)/);
    assert.match(formatAcceptancePromptBlock({
      version: 2,
      features: [
        { id: "palette", label: "Palette", accepted: true },
        { id: "applied_shell", label: "Applied", accepted: false },
      ],
    }), /IN SCOPE/);
  });

  it("uiSpecFromDesignLoopMock quotes content-aligned menubar shell contract", () => {
    const spec = uiSpecFromDesignLoopMock({
      brief: "shell layout",
      loopId: "loop-shell",
      version: 2,
      acceptance: {
        version: 2,
        features: [
          { id: "applied_shell", label: "Shell", accepted: true },
        ],
      },
      shellNotes: [
        "Menubar: center an inner bar at max-width: var(--content-max) matching page content (not full-bleed flex children).",
        "Menubar slots: logo + primary nav left; auth / theme (and optional view switcher) right within the inner bar.",
      ],
    });
    assert.match(spec, /Shell layout contract/);
    assert.match(spec, /content-max/);
    assert.match(spec, /logo \+ primary nav left/i);
  });

  it("uiSpecFromDesignLoopMock requires visibility/@source when togglePresent", () => {
    const spec = uiSpecFromDesignLoopMock({
      brief: "day/night theme toggle",
      loopId: "loop-vis",
      version: 1,
      acceptance: {
        version: 1,
        features: [
          { id: "theme_modes", label: "Theme", accepted: true },
          { id: "applied_shell", label: "Shell", accepted: true },
        ],
      },
      theme: {
        mechanism: "data-theme",
        defaultMode: "dark",
        modes: ["dark", "light"],
        togglePresent: true,
        requirements: ["ThemeToggle sets data-theme"],
        lightTokensCss: ":root[data-theme=light] { --background: #fff; }",
        darkTokensCss: "",
      },
    });
    assert.match(spec, /Visibility \(mandatory when togglePresent\)/);
    assert.match(spec, /@source/);
    assert.match(spec, /visible/);
    assert.match(spec, /text-text-secondary|style emission/);
  });

  it("persists REQUEST + version meta and transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dloop-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "Match JamPress",
    });
    writeDesignLoopMeta(root, meta);
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: scaffoldDesignLoopMock(meta.brief),
      notes: "Scaffold fallback (agent error): timed out",
      request: meta.brief,
      usedScaffold: true,
      error: "timed out",
    });
    appendDesignLoopTranscript(root, meta.id, "user", meta.brief);
    appendDesignLoopTranscript(root, meta.id, "assistant", "scaffold");

    assert.equal(readDesignLoopRequest(root, meta.id, 1)?.trim(), meta.brief);
    const vmeta = readDesignLoopVersionMeta(root, meta.id, 1);
    assert.equal(vmeta?.usedScaffold, true);
    assert.match(vmeta?.error ?? "", /timed out/);
    assert.match(readDesignLoopTranscript(root, meta.id), /Match JamPress/);

    setDesignLoopLastError(root, meta.id, {
      version: 1,
      reason: "timed out",
      at: new Date().toISOString(),
    });
    assert.equal(readDesignLoopMeta(root, meta.id)?.lastError?.version, 1);

    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: "<!DOCTYPE html><html><body>ok</body></html>",
      notes: "regenerated",
      request: meta.brief,
      usedScaffold: false,
    });
    setDesignLoopLastError(root, meta.id, null);
    assert.equal(readDesignLoopVersionMeta(root, meta.id, 1)?.usedScaffold, false);
    assert.equal(readDesignLoopMeta(root, meta.id)?.lastError, undefined);
  });

  it("rewriteDesignLoopAssetUrls maps disk paths to HTTP paths", () => {
    const loopId = "733abcb0-0541-45e1-af71-c877e5db769c";
    const html = `<img src=".slopcontrol/design-loops/${loopId}/assets/logo.png">
<img src="./.slopcontrol/design-loops/${loopId}/assets/mark.webp">
<a href="https://example.com/x.png">ext</a>
<img src="/other/path.png">`;
    const out = rewriteDesignLoopAssetUrls(html, {
      projectId: "proj-1",
      loopId,
    });
    assert.match(
      out,
      /src="\/projects\/proj-1\/design-loops\/733abcb0-0541-45e1-af71-c877e5db769c\/assets\/logo\.png"/,
    );
    assert.match(
      out,
      /src="\/projects\/proj-1\/design-loops\/733abcb0-0541-45e1-af71-c877e5db769c\/assets\/mark\.webp"/,
    );
    assert.match(out, /https:\/\/example\.com\/x\.png/);
    assert.match(out, /src="\/other\/path\.png"/);
  });

  it("writeDesignLoopVersion normalizes foreign-loop asset refs to held files", () => {
    const root = mkdtempSync(join(tmpdir(), "dl-normalize-"));
    roots.push(root);
    const loopId = "loop-new";
    const foreign = "11111111-2222-4333-8444-555555555555";
    mkdirSync(designLoopAssetsDir(root, loopId), { recursive: true });
    writeFileSync(join(designLoopAssetsDir(root, loopId), "logo.png"), "x");
    const { htmlPath } = writeDesignLoopVersion({
      projectRoot: root,
      loopId,
      version: 1,
      html: `<html><body>
<img src=".slopcontrol/design-loops/${foreign}/assets/logo.png">
<img src="./.slopcontrol/design-loops/${foreign}/assets/not-held.png">
<img src=".slopcontrol/design-loops/${loopId}/assets/already-own.png">
</body></html>`,
    });
    const stored = readFileSync(htmlPath, "utf-8");
    // Held file → repointed at this loop's own copy.
    assert.ok(
      stored.includes(`.slopcontrol/design-loops/${loopId}/assets/logo.png`),
    );
    // Unheld file → left pointing at the source loop (serve-time resolves it).
    assert.ok(
      stored.includes(`.slopcontrol/design-loops/${foreign}/assets/not-held.png`),
    );
    // Already-own ref → untouched even though the file is absent.
    assert.ok(
      stored.includes(`.slopcontrol/design-loops/${loopId}/assets/already-own.png`),
    );
  });

  it("rewriteDesignLoopAssetUrls rewrites foreign-loop paths from inherited mocks", () => {
    const sourceLoop = "11111111-2222-4333-8444-555555555555";
    const currentLoop = "99999999-8888-4777-a666-555555555555";
    const html = `<img src=".slopcontrol/design-loops/${sourceLoop}/assets/logo.png">
<img src="./.slopcontrol/design-loops/${currentLoop}/assets/own.png">`;
    const out = rewriteDesignLoopAssetUrls(html, {
      projectId: "proj-1",
      loopId: currentLoop,
    });
    assert.match(
      out,
      /src="\/projects\/proj-1\/design-loops\/11111111-2222-4333-8444-555555555555\/assets\/logo\.png"/,
    );
    assert.match(
      out,
      /src="\/projects\/proj-1\/design-loops\/99999999-8888-4777-a666-555555555555\/assets\/own\.png"/,
    );
  });

  it("rewriteDesignLoopAssetUrls leaves unrelated URLs alone and supports assetBase", () => {
    const loopId = "loop-a";
    const html = `<img src=".slopcontrol/design-loops/${loopId}/assets/a.png">`;
    const out = rewriteDesignLoopAssetUrls(html, {
      projectId: "p",
      loopId,
      assetBase: "http://localhost:3020",
    });
    assert.equal(
      out,
      `<img src="http://localhost:3020/projects/p/design-loops/loop-a/assets/a.png">`,
    );
  });

  it("resolveDesignLoopGenerateFallback keeps previous mock on continue failure", () => {
    const prior = "<!DOCTYPE html><html><body>keep-me</body></html>";
    const kept = resolveDesignLoopGenerateFallback({
      brief: "x",
      previousHtml: prior,
      errorDetail: "Headers Timeout Error",
      scaffold: () => "<html>scaffold</html>",
    });
    assert.equal(kept.html, prior);
    assert.equal(kept.usedScaffold, false);
    assert.match(kept.notes, /Kept previous mock/);

    const fresh = resolveDesignLoopGenerateFallback({
      brief: "x",
      previousHtml: null,
      errorDetail: "timeout",
      scaffold: (b) => `<html>${b}</html>`,
    });
    assert.equal(fresh.usedScaffold, true);
    assert.match(fresh.html, /x/);
  });

  it("formatDesignLoopReviseBlock includes tokens and section outline", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-revise-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "theme",
    });
    writeDesignLoopMeta(root, meta);
    const html = `<!DOCTYPE html><html><head><style>:root { --a: #f00; }</style></head>
<body>
<div class="section-label"><b>1</b> Palette — warm</div>
<div class="section-label"><b>2</b> Logo — ember</div>
</body></html>`;
    const block = formatDesignLoopReviseBlock({
      projectRoot: root,
      projectId: "p1",
      loopId: meta.id,
      previousHtml: html,
      maxHtmlChars: 500,
    });
    assert.match(block, /--a:\s*#f00/);
    assert.match(block, /palette/);
    assert.match(block, /logo/);
    assert.match(block, /```html/);
  });

  it("formatPhaseBoundMockPromptBlock cites design/mock.html", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-bound-mock-"));
    roots.push(root);
    const phaseId = "01-theme";
    const designDir = join(root, ".slopcontrol", "phases", phaseId, "design");
    mkdirSync(designDir, { recursive: true });
    writeFileSync(
      join(designDir, "mock.html"),
      `<!DOCTYPE html><html><head><style>:root{--x:1}</style></head>
<body><div class="section-label"><b>1</b> Logo — ring</div></body></html>\n`,
    );
    writeFileSync(join(designDir, "tokens.css"), `:root { --x: 1; }\n`);
    mkdirSync(join(designDir, "assets"), { recursive: true });
    writeFileSync(join(designDir, "assets", "ember.png"), "fake");

    const block = formatPhaseBoundMockPromptBlock({
      projectRoot: root,
      phaseId,
      maxHtmlChars: 2_000,
    });
    assert.match(block, new RegExp(`phases/${phaseId}/design/mock\\.html`));
    assert.match(block, /ember\.png/);
    assert.match(block, /competing logo/);
    assert.match(block, /logo/);
  });

  it("abandonDesignLoop marks the loop abandoned with reason and transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dloop-"));
    roots.push(root);
    const meta = createDesignLoopMeta({ projectId: "p1", brief: "wrong direction" });
    writeDesignLoopMeta(root, meta);

    const abandoned = abandonDesignLoop({
      projectRoot: root,
      loopId: meta.id,
      reason: "operator cancelled — completely wrong design",
    });
    assert.equal(abandoned.status, "abandoned");
    assert.equal(abandoned.abandonReason, "operator cancelled — completely wrong design");
    assert.ok(abandoned.abandonedAt);

    // Persisted + transcript recorded.
    const reread = readDesignLoopMeta(root, meta.id);
    assert.equal(reread?.status, "abandoned");
    assert.match(
      readDesignLoopTranscript(root, meta.id) ?? "",
      /Design loop abandoned: operator cancelled/,
    );

    // Idempotent.
    const again = abandonDesignLoop({ projectRoot: root, loopId: meta.id });
    assert.equal(again.status, "abandoned");

    // Unknown loop throws.
    assert.throws(() =>
      abandonDesignLoop({ projectRoot: root, loopId: "nope" }),
    );
  });

  it("abandonDesignLoop refuses implemented loops", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dloop-"));
    roots.push(root);
    const meta = createDesignLoopMeta({ projectId: "p1", brief: "shipped" });
    meta.status = "implemented";
    writeDesignLoopMeta(root, meta);
    assert.throws(
      () => abandonDesignLoop({ projectRoot: root, loopId: meta.id }),
      /already implemented/,
    );
  });
});
