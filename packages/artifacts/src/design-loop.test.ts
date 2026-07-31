import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  acceptDesignLoop,
  appendDesignLoopTranscript,
  bindAcceptedDesignLoopToPhase,
  createDesignLoopMeta,
  extractHtmlDocument,
  extractTokensCssFromHtml,
  readDesignLoopMeta,
  readDesignLoopRequest,
  readDesignLoopTranscript,
  readDesignLoopVersionMeta,
  scaffoldDesignLoopMock,
  setDesignLoopLastError,
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

  it("accept + bind writes phase design artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dloop-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "Dark chrome with orange accent",
    });
    writeDesignLoopMeta(root, meta);
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: scaffoldDesignLoopMock(meta.brief),
      notes: "v1 scaffold",
      request: meta.brief,
      usedScaffold: true,
      error: "timeout",
    });
    meta.currentVersion = 1;
    writeDesignLoopMeta(root, meta);

    const accepted = acceptDesignLoop(root, meta.id, 1);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.acceptedVersion, 1);

    const bound = bindAcceptedDesignLoopToPhase({
      projectRoot: root,
      loopId: meta.id,
      phaseId: "01-look",
    });
    assert.equal(bound.meta.status, "implemented");
    assert.equal(bound.meta.phaseId, "01-look");
    const again = readDesignLoopMeta(root, meta.id);
    assert.equal(again?.status, "implemented");
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
