import { extname } from "node:path";

export type SniffedFormat = "png" | "jpeg" | "webp" | "gif" | "svg" | "unknown";

/** Magic-byte sniff. SVG is optional BOM or whitespace, then `<?xml` or `<svg`. */
export function sniffImageFormat(buf: Buffer): SniffedFormat {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg";
  }
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  let start = 0;
  if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    start = 3;
  }
  const head = buf
    .subarray(start, Math.min(buf.length, start + 512))
    .toString("utf8")
    .trimStart();
  if (head.startsWith("<?xml") || /^<svg[\s>]/i.test(head)) return "svg";
  return "unknown";
}

export function extensionForFormat(format: SniffedFormat): string {
  switch (format) {
    case "png":
      return "png";
    case "jpeg":
      return "jpg";
    case "webp":
      return "webp";
    case "gif":
      return "gif";
    case "svg":
      return "svg";
    default:
      return "bin";
  }
}

export function contentTypeForFormat(format: SniffedFormat): string | null {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

/** Replace a trailing image extension. `withExtension("a/logo.svg", "png")` → `a/logo.png`. */
export function withExtension(path: string, format: SniffedFormat): string {
  const ext = extensionForFormat(format);
  const stripped = path.replace(/\.(png|jpe?g|webp|gif|svg|bin)$/i, "");
  return `${stripped}.${ext}`;
}

export function extensionAgrees(path: string, format: SniffedFormat): boolean {
  if (format === "unknown") return true;
  const ext = extname(path).toLowerCase();
  if (format === "jpeg") return ext === ".jpg" || ext === ".jpeg";
  return ext === `.${extensionForFormat(format)}`;
}

export function assertBytesMatchExtension(path: string, buf: Buffer): void {
  const sniffed = sniffImageFormat(buf);
  if (sniffed === "unknown" || !extensionAgrees(path, sniffed)) {
    throw new Error(
      `bytes_extension_mismatch: ${path} contains ${sniffed}`,
    );
  }
}
