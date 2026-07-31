import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  acceptDesignLoop,
  appendDesignLoopTranscript,
  bindAcceptedDesignLoopToPhase,
  createDesignLoopMeta,
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
});
