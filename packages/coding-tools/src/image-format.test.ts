import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertBytesMatchExtension,
  sniffImageFormat,
  withExtension,
} from "./image-format.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("image-format", () => {
  it("sniffs png, jpeg, webp, gif, svg, and garbage", () => {
    assert.equal(sniffImageFormat(PNG), "png");
    assert.equal(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "jpeg");
    const webp = Buffer.alloc(12);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    assert.equal(sniffImageFormat(webp), "webp");
    assert.equal(sniffImageFormat(Buffer.from("GIF89a")), "gif");
    assert.equal(
      sniffImageFormat(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")),
      "svg",
    );
    assert.equal(
      sniffImageFormat(Buffer.from("\uFEFF<?xml version=\"1.0\"?><svg></svg>")),
      "svg",
    );
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("  <?xml version=\"1.0\"?><svg></svg>"),
    ]);
    assert.equal(sniffImageFormat(bom), "svg");
    assert.equal(sniffImageFormat(Buffer.from("not an image")), "unknown");
  });

  it("rewrites the extension and rejects a mismatch", () => {
    assert.equal(withExtension("a/logo.svg", "png"), "a/logo.png");
    assert.doesNotThrow(() => assertBytesMatchExtension("a/logo.png", PNG));
    assert.throws(
      () => assertBytesMatchExtension("a/logo.svg", PNG),
      /bytes_extension_mismatch/,
    );
  });
});
