import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterRasterVisionPaths,
  isRasterVisionPath,
} from "./vision-chat.js";

describe("vision raster filter", () => {
  it("accepts raster paths and rejects svg", () => {
    assert.equal(isRasterVisionPath("a.png"), true);
    assert.equal(isRasterVisionPath("a.JPG"), true);
    assert.equal(isRasterVisionPath("a.svg"), false);
    assert.deepEqual(
      filterRasterVisionPaths(["a.svg", "b.png", "c.webp", "d.svg"]),
      ["b.png", "c.webp"],
    );
  });
});
