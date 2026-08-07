import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import sharp from "sharp";
import {
  applyDesignImageOp,
  applyDesignImagePipeline,
  listDesignImageOpIds,
  assertDesignImageOp,
  formatDesignImageCatalogForLlm,
} from "./index.js";

describe("design-image-catalog", () => {
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

  it("lists and asserts known ops", () => {
    const ids = listDesignImageOpIds();
    assert.ok(ids.includes("make_transparent"));
    assert.ok(ids.includes("circular_mask"));
    assert.ok(ids.includes("rotate"));
    assert.equal(assertDesignImageOp("resize"), "resize");
    assert.throws(() => assertDesignImageOp("teleport"), /Unknown image op/);
    assert.match(formatDesignImageCatalogForLlm(), /DESIGN IMAGE CAPABILITIES/);
  });

  it("applyDesignImageOp rotate + greyscale pipeline", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-catalog-"));
    roots.push(root);
    const loopId = "loop-c";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 200, g: 40, b: 10 },
      },
    })
      .png()
      .toFile(join(dir, "mark.png"));

    const rotated = await applyDesignImageOp({
      projectRoot: root,
      loopId,
      sourceFilename: "mark.png",
      op: "rotate",
      params: { angle: 90 },
    });
    assert.match(rotated.summary, /rotate/i);
    assert.ok(rotated.relativePath);

    const pipe = await applyDesignImagePipeline({
      projectRoot: root,
      loopId,
      sourceFilename: "mark.png",
      ops: [{ op: "greyscale" }, { op: "sharpen" }],
    });
    assert.equal(pipe.results.length, 2);
    assert.ok(pipe.summaries.every((s) => s.length > 0));
  });
});
