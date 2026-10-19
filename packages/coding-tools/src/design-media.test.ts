import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  clearOpenverseTokenCache,
  generateDesignImage,
  importDesignImage,
  worktreeAssetTarget,
  resolveDesignAssetOutPath,
  resolveServableDesignAsset,
  searchDesignImages,
} from "./design-media.js";

describe("design-media", () => {
  const roots: string[] = [];
  after(() => {
    clearOpenverseTokenCache();
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("resolveDesignAssetOutPath nests under loop assets", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-media-"));
    roots.push(root);
    const out = resolveDesignAssetOutPath({
      projectRoot: root,
      loopId: "loop-1",
      filename: "hero.png",
    });
    assert.match(out.relativePath, /\.slopcontrol\/design-loops\/loop-1\/assets\/hero\.png$/);
  });

  it("resolveServableDesignAsset rejects path traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-media-"));
    roots.push(root);
    assert.equal(resolveServableDesignAsset(root, "../etc/passwd"), null);
    assert.equal(resolveServableDesignAsset(root, "a/b.png"), null);
  });

  it("worktreeAssetTarget follows the written basename", () => {
    assert.equal(
      worktreeAssetTarget("/wt/public/brand/logo.svg", "/p/design/logo.png"),
      "/wt/public/brand/logo.png",
    );
  });

  it("a .svg filename writes a png and a vectorize hint", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-media-svg-"));
    roots.push(root);
    const originalFetch = globalThis.fetch;
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), {
        status: 200,
      })) as typeof fetch;
    try {
      const out = await generateDesignImage({
        projectRoot: root,
        prompt: "mark",
        filename: "logo.svg",
        endpoint: {
          id: "test-images",
          label: "test",
          baseUrl: "https://example.invalid/v1",
          apiType: "openai-images",
          modelId: "test-image-model",
          capabilities: { chat: false, vision: false, imageGen: true },
        },
      });
      assert.equal(out.format, "png");
      assert.equal(out.requestedSvg, true);
      assert.match(out.hint ?? "", /vectorize_design_image/);
      assert.match(out.path, /logo\.png$/);
      assert.equal(
        readFileSync(out.path).subarray(0, 4).toString("hex"),
        "89504e47",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("generateDesignImage hard-fails without endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-media-"));
    roots.push(root);
    await assert.rejects(
      () =>
        generateDesignImage({
          projectRoot: root,
          prompt: "logo",
          endpoint: undefined as never,
        }),
      /designImage unbound|required/i,
    );
  });

  it("searchDesignImages normalizes Openverse results", async () => {
    const hits = await searchDesignImages({
      query: "jam",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                id: "abc",
                title: "Jam jar",
                url: "https://example.com/a.jpg",
                thumbnail: "https://example.com/t.jpg",
                foreign_landing_url: "https://example.com/page",
                license: "cc0",
                license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
                creator: "Ada",
                source: "wikimedia",
                attribution: "Jam jar by Ada",
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "abc");
    assert.match(hits[0]?.attribution ?? "", /Ada/);
  });

  it("importDesignImage rejects http urls", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-media-"));
    roots.push(root);
    await assert.rejects(
      () =>
        importDesignImage({
          projectRoot: root,
          loopId: "loop-1",
          hit: {
            id: "x",
            title: "t",
            url: "http://example.com/a.jpg",
            thumbnail: "",
            foreignLandingUrl: "",
            license: "cc0",
            licenseUrl: "",
            creator: "c",
            source: "wikimedia",
            attribution: "a",
          },
        }),
      /https/i,
    );
  });

  it("importDesignImage writes asset + attribution", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-media-"));
    roots.push(root);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const result = await importDesignImage({
      projectRoot: root,
      loopId: "loop-1",
      filename: "stock.png",
      hit: {
        id: "ov-1",
        title: "Stock",
        url: "https://cdn.example.com/stock.png",
        thumbnail: "https://cdn.example.com/t.png",
        foreignLandingUrl: "https://example.com/page",
        license: "cc0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        creator: "Pat",
        source: "wikimedia",
        attribution: "Stock by Pat",
      },
      fetchImpl: (async () =>
        new Response(png, {
          status: 200,
          headers: { "content-type": "image/png" },
        })) as typeof fetch,
    });
    assert.match(result.relativePath, /stock\.png$/);
    const attr = JSON.parse(readFileSync(result.attributionPath, "utf-8"));
    assert.equal(attr.id, "ov-1");
    assert.equal(attr.creator, "Pat");
  });
});
