import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { accessSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import { optimize } from "svgo";
import {
  outPathScoped,
  resolveScopedAsset,
  type AssetScope,
} from "./asset-scope.js";
import { assertBytesMatchExtension, sniffImageFormat } from "./image-format.js";

export type VectorizeParams = {
  tokensCss?: string;
  palette?: Array<string | { name: string; hex: string }>;
  maxColors?: number;
  snap?: "tokens" | "tokens+extra";
  snapMaxDeltaE?: number;
  colorMap?: Array<{ from: string; to: string }>;
  dropRegions?: Array<{
    x: number;
    y: number;
    w: number;
    h: number;
    into?: string;
    variantsOnly?: boolean;
  }>;
  minAlpha?: number;
  modeFilterPx?: number;
  variants?: number[];
  variantDrop?: string[];
  variantThicken?: string[];
  square?: boolean;
  padding?: number;
  mats?: { dark: string; light: string };
  previewSizes?: number[];
  filename?: string;
  potrace?: { alphamax?: number; opttolerance?: number; turdsize?: number };
};

export type VectorizeStatus = "passed" | "passed_with_warnings" | "failed";

export type SvgCheck = {
  id: string;
  ok: boolean;
  severity: "error" | "warn";
  detail?: string;
};

export type VectorizeReport = {
  crop: { x: number; y: number; w: number; h: number };
  colours: Array<{
    from: string;
    to: string;
    token?: string;
    deltaE: number;
    share: number;
  }>;
  outputs: Array<{ filename: string; profile: string; checks: SvgCheck[] }>;
  warnings: string[];
};

export type VectorizeFile = {
  filename: string;
  relativePath: string;
  size?: number;
  kind: "svg" | "preview" | "sheet" | "report";
};

export type VectorizeResult = {
  op: "vectorize";
  status: VectorizeStatus;
  relativePath: string;
  absolutePath: string;
  sourceFilename: string;
  summary: string;
  files: VectorizeFile[];
  report: VectorizeReport;
  validateOnly?: boolean;
};

export class VectorizeError extends Error {
  code:
    | "source_not_found"
    | "potrace_not_found"
    | "potrace_timeout"
    | "bytes_extension_mismatch"
    | "palette_unreadable"
    | "invalid_params";

  constructor(
    code: VectorizeError["code"],
    message?: string,
  ) {
    super(message ?? code);
    this.name = "VectorizeError";
    this.code = code;
  }
}

export function vectorizeErrorCode(error: unknown): VectorizeError["code"] | null {
  if (error instanceof VectorizeError) return error.code;
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.startsWith("source_not_found")) return "source_not_found";
  if (msg.startsWith("potrace_not_found")) return "potrace_not_found";
  if (msg.startsWith("potrace_timeout")) return "potrace_timeout";
  if (msg.startsWith("bytes_extension_mismatch")) return "bytes_extension_mismatch";
  if (msg.startsWith("palette_unreadable")) return "palette_unreadable";
  if (msg.startsWith("invalid_params")) return "invalid_params";
  return null;
}

type RGB = { r: number; g: number; b: number };
type Lab = { L: number; a: number; b: number };

const POTRACE_MISSING =
  'potrace_not_found: install with "brew install potrace" or set SLOPCONTROL_POTRACE_BIN';

export function resolvePotraceBin(): string {
  const fromEnv = process.env.SLOPCONTROL_POTRACE_BIN?.trim();
  return fromEnv || "potrace";
}

export function potraceAvailability(): { available: boolean; bin: string | null } {
  const requested = resolvePotraceBin();
  if (requested.includes("/") || requested.includes("\\")) {
    try {
      accessSync(requested, constants.X_OK);
      return { available: true, bin: requested };
    } catch {
      return { available: false, bin: requested };
    }
  }
  const which = spawnSync("which", [requested], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim() : "";
  if (found) return { available: true, bin: found };
  return { available: false, bin: null };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function srgbToLab(rgb: RGB): Lab {
  const R = lin(rgb.r / 255);
  const G = lin(rgb.g / 255);
  const B = lin(rgb.b / 255);
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = R * 0.0193339 + G * 0.119192 + B * 0.9503041;
  const f = (t: number) => {
    const d = 6 / 29;
    return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
  };
  const fx = f(X / 0.95047);
  const fy = f(Y / 1);
  const fz = f(Z / 1.08883);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIEDE2000. Inline so snaps stay deterministic and dependency-free. */
export function deltaE00(a: Lab, b: Lab): number {
  const kL = 1;
  const kC = 1;
  const kH = 1;
  const C1 = Math.hypot(a.a, a.b);
  const C2 = Math.hypot(b.a, b.b);
  const cBar = (C1 + C2) / 2;
  const cBar7 = cBar ** 7;
  const G = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const a1p = (1 + G) * a.a;
  const a2p = (1 + G) * b.a;
  const C1p = Math.hypot(a1p, a.b);
  const C2p = Math.hypot(a2p, b.b);
  const hp = (aa: number, bb: number) => {
    if (aa === 0 && bb === 0) return 0;
    let h = (Math.atan2(bb, aa) * 180) / Math.PI;
    if (h < 0) h += 360;
    return h;
  };
  const h1 = hp(a1p, a.b);
  const h2 = hp(a2p, b.b);
  const dLp = b.L - a.L;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2 - h1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(((dhp * Math.PI) / 180) / 2);
  const Lbar = (a.L + b.L) / 2;
  const Cpbar = (C1p + C2p) / 2;
  let hbar = (h1 + h2) / 2;
  if (C1p * C2p !== 0 && Math.abs(h1 - h2) > 180) {
    hbar = (h1 + h2 + 360) / 2;
  }
  if (hbar >= 360) hbar -= 360;
  const rad = Math.PI / 180;
  const T =
    1 -
    0.17 * Math.cos((hbar - 30) * rad) +
    0.24 * Math.cos(2 * hbar * rad) +
    0.32 * Math.cos((3 * hbar + 6) * rad) -
    0.2 * Math.cos((4 * hbar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const Cp7 = Cpbar ** 7;
  const Rc = 2 * Math.sqrt(Cp7 / (Cp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cpbar;
  const Sh = 1 + 0.015 * Cpbar * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    (dLp / (kL * Sl)) ** 2 +
      (dCp / (kC * Sc)) ** 2 +
      (dHp / (kH * Sh)) ** 2 +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

export function normalizeHex(input: string): string | null {
  const raw = input.trim();
  const m = raw.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (!m) return null;
  let hex = m[1]!.toUpperCase();
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length === 8) hex = hex.slice(0, 6);
  return `#${hex}`;
}

function hexToRgb(hex: string): RGB {
  const n = normalizeHex(hex);
  if (!n) throw new VectorizeError("invalid_params", `invalid_params: ${hex}`);
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

function rgbToHex(rgb: RGB): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${c(rgb.r)}${c(rgb.g)}${c(rgb.b)}`;
}

function rgbKey(rgb: RGB): number {
  return (rgb.r << 16) | (rgb.g << 8) | rgb.b;
}

function keyToRgb(key: number): RGB {
  return { r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 };
}

/** :root hex custom properties. Ignores rgba() and blocks outside :root. */
export function parseTokensCssPalette(
  css: string,
): Array<{ name: string; hex: string }> {
  const withoutTheme = css.replace(/\[[^\]]+\]\s*\{[^}]*\}/g, "");
  const roots = [...withoutTheme.matchAll(/:root\s*\{([^}]*)\}/g)];
  const out: Array<{ name: string; hex: string }> = [];
  const seen = new Set<string>();
  for (const block of roots) {
    const body = block[1] ?? "";
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
      const name = m[1]!;
      const hex = normalizeHex(m[2]!);
      if (!hex || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, hex });
    }
  }
  return out;
}

export function readLoopTokenPalette(
  projectRoot: string,
  loopId: string,
): string[] {
  const dir = join(projectRoot, ".slopcontrol", "design-loops", loopId);
  for (const name of ["DESIGN_PACK.json", "SHARED_FROM.json", "PRIOR_DESIGN.json"]) {
    try {
      const json = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        tokens?: string;
        tokensCss?: string;
      };
      const css =
        (typeof json.tokens === "string" && json.tokens) ||
        (typeof json.tokensCss === "string" && json.tokensCss) ||
        "";
      const parsed = parseTokensCssPalette(css);
      if (parsed.length) return parsed.map((p) => p.hex);
    } catch {
      /* try the next record */
    }
  }
  return [];
}

type PaletteEntry = { name?: string; hex: string; lab: Lab };

function resolvePalette(
  projectRoot: string,
  params: VectorizeParams,
): { entries: PaletteEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  let fromCss: Array<{ name: string; hex: string }> = [];
  if (params.tokensCss?.trim()) {
    const abs = resolve(projectRoot, params.tokensCss);
    const root = resolve(projectRoot);
    if (!abs.startsWith(root + sep) && abs !== root) {
      throw new VectorizeError("palette_unreadable", "palette_unreadable");
    }
    if (!existsSync(abs)) {
      throw new VectorizeError("palette_unreadable", "palette_unreadable");
    }
    try {
      fromCss = parseTokensCssPalette(readFileSync(abs, "utf8"));
    } catch {
      throw new VectorizeError("palette_unreadable", "palette_unreadable");
    }
  }
  const requested = params.palette ?? [];
  let entries: Array<{ name?: string; hex: string }> = [];
  if (fromCss.length && requested.length) {
    const allow = new Set<string>();
    for (const item of requested) {
      if (typeof item === "string") {
        const hex = normalizeHex(item);
        if (hex) allow.add(hex);
        else allow.add(item.trim());
      } else {
        allow.add(item.name);
        const hex = normalizeHex(item.hex);
        if (hex) allow.add(hex);
      }
    }
    entries = fromCss.filter(
      (e) => allow.has(e.name) || allow.has(e.hex),
    );
  } else if (fromCss.length) {
    entries = fromCss;
  } else {
    for (const item of requested) {
      if (typeof item === "string") {
        const hex = normalizeHex(item);
        if (!hex) {
          throw new VectorizeError("invalid_params", `invalid_params: ${item}`);
        }
        entries.push({ hex });
      } else {
        const hex = normalizeHex(item.hex);
        if (!hex) {
          throw new VectorizeError(
            "invalid_params",
            `invalid_params: ${item.hex}`,
          );
        }
        entries.push({ name: item.name, hex });
      }
    }
  }
  if (!entries.length) warnings.push("no_palette");
  return {
    entries: entries.map((e) => ({ ...e, lab: srgbToLab(hexToRgb(e.hex)) })),
    warnings,
  };
}

function nearestPalette(
  lab: Lab,
  palette: PaletteEntry[],
): { entry: PaletteEntry; deltaE: number } | null {
  let best: { entry: PaletteEntry; deltaE: number } | null = null;
  for (const entry of palette) {
    const deltaE = deltaE00(lab, entry.lab);
    if (!best || deltaE < best.deltaE) best = { entry, deltaE };
  }
  return best;
}

type Cluster = {
  key: number;
  count: number;
  lab: Lab;
  to: string;
  token?: string;
  deltaE: number;
};

function clusterColours(
  hist: Map<number, number>,
  palette: PaletteEntry[],
  params: VectorizeParams,
  warnings: string[],
): Cluster[] {
  const maxColors = Math.min(12, Math.max(1, params.maxColors ?? 8));
  const snap = params.snap ?? "tokens";
  const snapMax = params.snapMaxDeltaE ?? 18;
  const keys = [...hist.keys()].sort((a, b) => a - b);
  if (!keys.length) return [];
  const rng = mulberry32(1);
  let seeds: number[] = [];
  if (palette.length) {
    const used = new Set<number>();
    for (const entry of palette) {
      let best = keys[0]!;
      let bestD = Infinity;
      for (const key of keys) {
        const d = deltaE00(srgbToLab(keyToRgb(key)), entry.lab);
        if (d < bestD) {
          bestD = d;
          best = key;
        }
      }
      if (!used.has(best)) {
        used.add(best);
        seeds.push(best);
      }
    }
  }
  const pool = keys.filter((k) => !seeds.includes(k));
  while (seeds.length < Math.min(maxColors, keys.length) && pool.length) {
    const idx = Math.floor(rng() * pool.length);
    seeds.push(pool.splice(idx, 1)[0]!);
  }
  if (keys.length <= maxColors) seeds = keys.slice();

  let centers = seeds.map((key) => srgbToLab(keyToRgb(key)));
  let assign = new Map<number, number>();
  for (let iter = 0; iter < 16; iter++) {
    assign = new Map();
    const sum = centers.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (const key of keys) {
      const lab = srgbToLab(keyToRgb(key));
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d =
          (lab.L - centers[i]!.L) ** 2 +
          (lab.a - centers[i]!.a) ** 2 +
          (lab.b - centers[i]!.b) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      assign.set(key, bi);
      const n = hist.get(key) ?? 0;
      sum[bi]!.L += lab.L * n;
      sum[bi]!.a += lab.a * n;
      sum[bi]!.b += lab.b * n;
      sum[bi]!.n += n;
    }
    const next = sum.map((s, i) =>
      s.n > 0
        ? { L: s.L / s.n, a: s.a / s.n, b: s.b / s.n }
        : centers[i]!,
    );
    centers = next;
  }

  const grouped = new Map<string, Cluster>();
  for (const key of keys) {
    const idx = assign.get(key) ?? 0;
    const lab = centers[idx] ?? srgbToLab(keyToRgb(key));
    const count = hist.get(key) ?? 0;
    const from = rgbToHex(keyToRgb(key));
    let to = from;
    let token: string | undefined;
    let deltaE = 0;
    if (palette.length) {
      const near = nearestPalette(lab, palette);
      if (near) {
        deltaE = near.deltaE;
        token = near.entry.name;
        if (snap === "tokens+extra" && deltaE > snapMax) {
          to = from;
          warnings.push(`far_cluster:${from}`);
        } else {
          if (deltaE > snapMax) warnings.push(`far_cluster:${from}`);
          to = near.entry.hex;
        }
      }
    }
    const prev = grouped.get(to);
    if (prev) {
      prev.count += count;
      if (deltaE < prev.deltaE) {
        prev.deltaE = deltaE;
        prev.token = token;
        prev.key = key;
      }
    } else {
      grouped.set(to, { key, count, lab, to, token, deltaE });
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || (a.to < b.to ? -1 : 1));
}

function applyClusterColorMap(
  clusters: Cluster[],
  maps: VectorizeParams["colorMap"],
  palette: PaletteEntry[],
): Cluster[] {
  if (!maps?.length) return clusters;
  const next: Cluster[] = [];
  for (const cluster of clusters) {
    const mapped = applyColorMap(hexToRgb(cluster.to), maps, palette);
    if (mapped === null) continue;
    const to = rgbToHex(mapped);
    const prev = next.find((c) => c.to === to);
    if (prev) {
      prev.count += cluster.count;
      continue;
    }
    next.push({ ...cluster, to });
  }
  return next;
}

function applyColorMap(rgb: RGB, maps: VectorizeParams["colorMap"], palette: PaletteEntry[]): RGB | null {
  if (!maps?.length) return rgb;
  const hex = rgbToHex(rgb);
  for (const map of maps) {
    const from = normalizeHex(map.from);
    if (!from || from !== hex) continue;
    if (map.to.trim().toLowerCase() === "transparent") return null;
    const direct = normalizeHex(map.to);
    if (direct) return hexToRgb(direct);
    const token = palette.find((p) => p.name === map.to.trim());
    if (token) return hexToRgb(token.hex);
    throw new VectorizeError("invalid_params", `invalid_params: ${map.to}`);
  }
  return rgb;
}

function tracePbm(
  bits: Uint8Array,
  w: number,
  h: number,
  args: string[],
): Promise<string> {
  const bin = resolvePotraceBin();
  const avail = potraceAvailability();
  if (!avail.available) {
    throw new VectorizeError("potrace_not_found", POTRACE_MISSING);
  }
  const rowBytes = Math.ceil(w / 8);
  const body = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x]) {
        const byte = body[y * rowBytes + (x >> 3)] ?? 0;
        body[y * rowBytes + (x >> 3)] = byte | (0x80 >> (x & 7));
      }
    }
  }
  const pbm = Buffer.concat([Buffer.from(`P4\n${w} ${h}\n`), body]);
  const timeoutMs = Math.max(
    1_000,
    Number(process.env.SLOPCONTROL_POTRACE_TIMEOUT_MS ?? 30_000) || 30_000,
  );
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, ["-b", "svg", "--flat", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // A hung tracer must not stall a design run; kill and surface a typed error.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() =>
        reject(
          new VectorizeError(
            "potrace_timeout",
            `potrace_timeout: no result after ${timeoutMs}ms`,
          ),
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (c) => out.push(c as Buffer));
    child.stderr.on("data", (c) => err.push(c as Buffer));
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() => {
        if (error.code === "ENOENT") {
          reject(new VectorizeError("potrace_not_found", POTRACE_MISSING));
          return;
        }
        reject(error);
      });
    });
    child.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(
            new Error(
              `potrace_failed: ${Buffer.concat(err).toString("utf8").slice(0, 200)}`,
            ),
          );
          return;
        }
        resolvePromise(Buffer.concat(out).toString("utf8"));
      });
    });
    child.stdin.on("error", () => undefined); // EPIPE after a timeout kill is expected
    child.stdin.write(pbm);
    child.stdin.end();
  });
}

function pathTokens(d: string): string[] {
  return d.match(/[a-zA-Z]|-?(?:\d+\.\d+|\d+|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
}

function transformPath(
  d: string,
  map: (x: number, y: number) => [number, number],
): string {
  const tokens = pathTokens(d);
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const out: string[] = [];
  const fmt = (n: number) => {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
  };
  const take = () => {
    const n = Number(tokens[i++]);
    if (!Number.isFinite(n)) throw new Error("bad path");
    return n;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i] ?? "")) cmd = tokens[i++]!;
    if (!cmd) break;
    const upper = cmd.toUpperCase();
    const abs = cmd === upper;
    const absPoint = (x: number, y: number): [number, number] =>
      abs ? [x, y] : [cx + x, cy + y];
    if (upper === "Z") {
      out.push("Z");
      cx = sx;
      cy = sy;
      continue;
    }
    if (upper === "H") {
      const x = take();
      const [ax] = absPoint(x, cy);
      const [nx, ny] = map(ax, cy);
      out.push(`L${fmt(nx)} ${fmt(ny)}`);
      cx = ax;
      continue;
    }
    if (upper === "V") {
      const y = take();
      const [, ay] = absPoint(cx, y);
      const [nx, ny] = map(cx, ay);
      out.push(`L${fmt(nx)} ${fmt(ny)}`);
      cy = ay;
      continue;
    }
    if (upper === "M" || upper === "L" || upper === "T") {
      const x = take();
      const y = take();
      const [ax, ay] = absPoint(x, y);
      const [nx, ny] = map(ax, ay);
      out.push(`${upper}${fmt(nx)} ${fmt(ny)}`);
      cx = ax;
      cy = ay;
      if (upper === "M") {
        sx = ax;
        sy = ay;
      }
      continue;
    }
    if (upper === "C" || upper === "S" || upper === "Q") {
      const count = upper === "C" ? 3 : 2;
      const startX = cx;
      const startY = cy;
      const pts: number[] = [];
      let lastX = cx;
      let lastY = cy;
      for (let k = 0; k < count; k++) {
        const rawX = take();
        const rawY = take();
        const ax = abs ? rawX : startX + rawX;
        const ay = abs ? rawY : startY + rawY;
        const [nx, ny] = map(ax, ay);
        pts.push(nx, ny);
        lastX = ax;
        lastY = ay;
      }
      cx = lastX;
      cy = lastY;
      const pairs: string[] = [];
      for (let k = 0; k < pts.length; k += 2) {
        pairs.push(`${fmt(pts[k]!)} ${fmt(pts[k + 1]!)}`);
      }
      out.push(`${upper}${pairs.join(" ")}`);
      continue;
    }
    if (upper === "A") {
      take();
      take();
      take();
      take();
      take();
      const [ax, ay] = absPoint(take(), take());
      const [nx, ny] = map(ax, ay);
      out.push(`L${fmt(nx)} ${fmt(ny)}`);
      cx = ax;
      cy = ay;
      continue;
    }
    throw new Error(`unsupported path command ${cmd}`);
  }
  return out.join("");
}

function potracePathsToCrop(
  svg: string,
  traceW: number,
  traceH: number,
  cropW: number,
  cropH: number,
): string {
  const transform = svg.match(/transform="([^"]+)"/)?.[1] ?? "";
  const tr = transform.match(/translate\(\s*([-\d.]+)(?:[,\s]+([-\d.]+))?\s*\)/);
  const sc = transform.match(/scale\(\s*([-\d.]+)(?:[,\s]+([-\d.]+))?\s*\)/);
  const tx = tr ? Number(tr[1]) : 0;
  const ty = tr ? Number(tr[2] ?? 0) : 0;
  const sx = sc ? Number(sc[1]) : 1;
  const sy = sc ? Number(sc[2] ?? sc[1]) : 1;
  const ds = [...svg.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]!);
  if (!ds.length) return "";
  const d = transformPath(ds.join(" "), (x, y) => [x * sx + tx, y * sy + ty]);
  if (traceW === cropW && traceH === cropH) return d;
  return transformPath(d, (x, y) => [(x / traceW) * cropW, (y / traceH) * cropH]);
}

function optimizeSvg(svg: string): string {
  const result = optimize(svg, {
    multipass: true,
    floatPrecision: 2,
    plugins: [
      {
        name: "preset-default",
        params: {
          overrides: {
            convertPathData: { floatPrecision: 2 },
          },
        },
      },
    ],
  });
  if ("data" in result && result.data) return result.data;
  return svg;
}

function assembleSvg(
  stem: string,
  layers: Array<{ hex: string; token?: string; d: string }>,
  box: { x: number; y: number; w: number; h: number },
): string {
  const paths = layers
    .filter((l) => l.d.trim())
    .map((l) => {
      const token = l.token ? ` data-token="${l.token}"` : "";
      return `<path fill="${l.hex}"${token} d="${l.d}"/>`;
    })
    .join("");
  const vb = `${round2(box.x)} ${round2(box.y)} ${round2(box.w)} ${round2(box.h)}`;
  const raw = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img"><title>${escapeXml(stem)}</title>${paths}</svg>\n`;
  const optimized = optimizeSvg(raw);
  const withBox = optimized.includes("viewBox")
    ? optimized
    : optimized.replace("<svg", `<svg viewBox="${vb}"`);
  return canonicalizeFills(withBox);
}

function canonicalizeFills(svg: string): string {
  return svg.replace(/fill="(#[0-9a-fA-F]{3,8})"/g, (_m, hex: string) => {
    const n = normalizeHex(hex);
    return n ? `fill="${n}"` : `fill="${hex}"`;
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

function applySquarePadding(
  svg: string,
  cropW: number,
  cropH: number,
  square: boolean,
  padding: number,
): string {
  let x = 0;
  let y = 0;
  let w = cropW;
  let h = cropH;
  let dx = 0;
  let dy = 0;
  if (square) {
    const side = Math.max(w, h);
    dx = (side - w) / 2;
    dy = (side - h) / 2;
    w = side;
    h = side;
  }
  if (padding > 0) {
    const px = w * padding;
    const py = h * padding;
    x -= px;
    y -= py;
    w += px * 2;
    h += py * 2;
    dx += px;
    dy += py;
  }
  let next = svg;
  if (dx || dy) {
    next = next.replace(/\bd="([^"]+)"/g, (_m, d: string) => {
      return `d="${transformPath(d, (px, py) => [px + dx, py + dy])}"`;
    });
  }
  const vb = `${round2(x)} ${round2(y)} ${round2(w)} ${round2(h)}`;
  if (/viewBox="[^"]*"/.test(next)) {
    next = next.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
  }
  next = next.replace(/\s(?:width|height)="[^"]*"/g, "");
  if (!/role="img"/.test(next)) next = next.replace("<svg", '<svg role="img"');
  if (!/<title>/.test(next)) {
    next = next.replace(/<svg([^>]*)>/, `<svg$1><title>${escapeXml(stemFromSvg(next))}</title>`);
  }
  return canonicalizeFills(next);
}

function stemFromSvg(svg: string): string {
  return svg.match(/<title>([^<]*)<\/title>/)?.[1] ?? "mark";
}

function countSubpaths(svg: string): number {
  const ds = [...svg.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1] ?? "");
  return ds.reduce((n, d) => n + (d.match(/[Mm]/g)?.length ?? 0), 0);
}

const PROFILE_LIMITS = {
  master: { elements: 16, subpaths: 80, bytes: 15 * 1024, fills: 12, feature: null as number | null },
  small: { elements: 8, subpaths: 30, bytes: 6 * 1024, fills: 4, feature: 1.5 },
  micro: { elements: 6, subpaths: 20, bytes: 4 * 1024, fills: 3, feature: 1.25 },
} as const;

function contrastRatio(a: RGB, b: RGB): number {
  const rel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = (rgb: RGB) => 0.2126 * rel(rgb.r) + 0.7152 * rel(rgb.g) + 0.0722 * rel(rgb.b);
  const l1 = L(a);
  const l2 = L(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export async function validateDesignSvg(
  svg: string | Buffer,
  profile: "master" | "small" | "micro",
  ctx?: {
    palette?: string[];
    reference?: Buffer;
    referenceWidth?: number;
    referenceHeight?: number;
    snap?: "tokens" | "tokens+extra";
    maxColors?: number;
    square?: boolean;
    padding?: number;
  },
): Promise<SvgCheck[]> {
  const text = Buffer.isBuffer(svg) ? svg.toString("utf8") : svg;
  const buf = Buffer.isBuffer(svg) ? svg : Buffer.from(svg);
  const limits = PROFILE_LIMITS[profile];
  const checks: SvgCheck[] = [];
  const push = (
    id: string,
    ok: boolean,
    severity: "error" | "warn",
    detail?: string,
  ) => checks.push({ id, ok, severity, detail });

  const sniffed = sniffImageFormat(buf);
  push("is_svg", sniffed === "svg", "error", sniffed);

  let rendered: { data: Buffer; info: { width: number; height: number } } | null =
    null;
  try {
    rendered = await sharp(buf, { density: 216 })
      .ensureAlpha()
      .resize(512, 512, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let i = 3; i < rendered.data.length; i += 4) {
      if (rendered.data[i]! > 0) opaque++;
    }
    push("renders", opaque >= 1, "error", String(opaque));
  } catch (error) {
    push(
      "renders",
      false,
      "error",
      error instanceof Error ? error.message : String(error),
    );
  }

  push(
    "no_raster",
    !/<image\b|<foreignObject\b|data:|base64|href=/i.test(text),
    "error",
  );
  push(
    "flat_only",
    !/gradient|<filter\b|<mask\b|<clipPath\b|<pattern\b|opacity\s*=\s*"0?\.\d|stroke\s*=|<text\b/i.test(
      text,
    ),
    "error",
  );
  const paths = text.match(/<path\b/gi)?.length ?? 0;
  push("has_paths", paths >= 1, "error", String(paths));
  const elements =
    text.match(/<(?:path|rect|circle|polygon|polyline|ellipse|line)\b/gi)
      ?.length ?? 0;
  push("elements", elements <= limits.elements, "error", String(elements));
  const subpaths = countSubpaths(text);
  push("subpaths", subpaths <= limits.subpaths, "warn", String(subpaths));
  push("bytes", buf.length <= limits.bytes, "error", String(buf.length));

  const fills = [
    ...text.matchAll(/fill="(#[0-9A-Fa-f]{3,8})"/g),
  ].map((m) => normalizeHex(m[1]!)!);
  const distinct = [...new Set(fills.filter(Boolean))];
  const palette = (ctx?.palette ?? []).map((h) => normalizeHex(h)).filter(Boolean);
  const snap = ctx?.snap ?? "tokens";
  if (snap === "tokens" && palette.length) {
    push(
      "palette_fills",
      distinct.every((f) => palette.includes(f)),
      "error",
      distinct.join(","),
    );
  }
  const fillCap = profile === "master" ? (ctx?.maxColors ?? 8) : limits.fills;
  push("max_fills", distinct.length <= fillCap, "warn", String(distinct.length));

  const vb = text.match(/viewBox="([^"]+)"/);
  let box: number[] = [];
  if (vb) box = vb[1]!.trim().split(/[\s,]+/).map(Number);
  const widthAttr = text.match(/\bwidth="([\d.]+)/);
  const heightAttr = text.match(/\bheight="([\d.]+)/);
  let viewOk = box.length === 4 && box.every((n) => Number.isFinite(n)) && box[2]! > 0 && box[3]! > 0;
  if (viewOk && widthAttr && Math.abs(Number(widthAttr[1]) - box[2]!) > 0.5) viewOk = false;
  if (viewOk && heightAttr && Math.abs(Number(heightAttr[1]) - box[3]!) > 0.5) viewOk = false;
  push("has_viewbox", viewOk, "error");

  if (rendered && viewOk) {
    const { data, info } = rendered;
    let minX = info.width;
    let minY = info.height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3]! < 16) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const allow = 0.01 + (ctx?.padding ?? 0);
    const mL = minX / info.width;
    const mR = (info.width - 1 - maxX) / info.width;
    const mT = minY / info.height;
    const mB = (info.height - 1 - maxY) / info.height;
    const sides = [mL, mR, mT, mB];
    const square = ctx?.square !== false;
    const tight = square
      ? sides.filter((m) => m <= Math.max(...sides) - 0.02).every((m) => m <= allow) ||
        sides.filter((m) => m < 0.2).every((m) => m <= allow)
      : sides.every((m) => m <= allow);
    push("viewbox_tight", tight, "error", sides.map((n) => n.toFixed(3)).join(","));
  } else {
    push("viewbox_tight", false, "error");
  }

  if (profile === "master" && ctx?.reference && rendered) {
    try {
      const ref = await sharp(ctx.reference)
        .ensureAlpha()
        .resize(256, 256, { fit: "fill" })
        .raw()
        .toBuffer();
      const got = await sharp(buf, { density: 216 })
        .ensureAlpha()
        .resize(256, 256, { fit: "fill" })
        .raw()
        .toBuffer();
      let inter = 0;
      let union = 0;
      for (let i = 3; i < ref.length; i += 4) {
        const a = ref[i]! >= 128;
        const b = got[i]! >= 128;
        if (a || b) union++;
        if (a && b) inter++;
      }
      const iou = union ? inter / union : 0;
      push("fidelity", iou >= 0.97, "warn", iou.toFixed(3));
    } catch {
      push("fidelity", false, "warn", "render");
    }
  }

  push("a11y", /role="img"/.test(text) && /<title>/.test(text), "warn");

  if (limits.feature != null && rendered) {
    const target = profile === "micro" ? 16 : 32;
    try {
      const small = await sharp(buf, { density: 288 })
        .ensureAlpha()
        .resize(target, target, { fit: "fill" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const thick = featureThickness(small.data, small.info.width, small.info.height);
      const errorAt = profile === "micro" && thick > 0 && thick < 1;
      push(
        "min_feature",
        thick === 0 || thick >= limits.feature,
        errorAt ? "error" : "warn",
        thick.toFixed(2),
      );
    } catch {
      push("min_feature", false, "warn");
    }
  }

  if (rendered) {
    const mats = [
      hexToRgb("#111111"),
      hexToRgb("#FFFFFF"),
    ];
    let ok = true;
    for (const mat of mats) {
      const sample = edgeColour(rendered.data, rendered.info.width, rendered.info.height);
      if (!sample) continue;
      const ratio = contrastRatio(sample, mat);
      if (ratio < 1.1) continue;
      if (ratio < 2) ok = false;
    }
    push("edge_contrast", ok, "warn");
  }

  return checks;
}

function featureThickness(data: Buffer, w: number, h: number): number {
  const dist = new Float32Array(w * h);
  const opaque = (x: number, y: number) => data[(y * w + x) * 4 + 3]! >= 128;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      let best = 1;
      if (x > 0 && dist[y * w + x - 1]) best = Math.min(best, dist[y * w + x - 1]! + 1);
      if (y > 0 && dist[(y - 1) * w + x]) best = Math.min(best, dist[(y - 1) * w + x]! + 1);
      dist[y * w + x] = best;
    }
  }
  let peak = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i]! > peak) peak = dist[i]!;
  return peak * 2;
}

function edgeColour(data: Buffer, w: number, h: number): RGB | null {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3]! < 128) continue;
      const edge =
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        data[i - 1]! < 128 ||
        data[i + 7]! < 128 ||
        data[i - w * 4 + 3]! < 128 ||
        data[i + w * 4 + 3]! < 128;
      if (edge) return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]! };
    }
  }
  return null;
}

export function validationStatus(checks: SvgCheck[]): VectorizeStatus {
  if (checks.some((c) => !c.ok && c.severity === "error")) return "failed";
  if (checks.some((c) => !c.ok && c.severity === "warn")) return "passed_with_warnings";
  return "passed";
}

function worstStatus(list: VectorizeStatus[]): VectorizeStatus {
  if (list.includes("failed")) return "failed";
  if (list.includes("passed_with_warnings")) return "passed_with_warnings";
  return "passed";
}

async function loadRaster(path: string): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const bytes = readFileSync(path);
  const sniffed = sniffImageFormat(bytes);
  if (sniffed === "svg") {
    const rendered = await sharp(bytes, { density: 144 })
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: false })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      data: rendered.data,
      width: rendered.info.width,
      height: rendered.info.height,
    };
  }
  assertBytesMatchExtension(path, bytes);
  const rendered = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
  };
}

function cropAlpha(
  data: Buffer,
  width: number,
  height: number,
  minAlpha: number,
): { data: Buffer; width: number; height: number; x: number; y: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! < minAlpha) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    data.copy(out, y * w * 4, ((y + minY) * width + minX) * 4, ((y + minY) * width + minX + w) * 4);
  }
  return { data: out, width: w, height: h, x: minX, y: minY };
}

async function upscale(
  data: Buffer,
  width: number,
  height: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  const long = Math.max(width, height);
  if (long >= 1024) return { data, width, height };
  const scale = 1024 / long;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const rendered = await sharp(data, { raw: { width, height, channels: 4 } })
    .resize(w, h, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: rendered.data, width: rendered.info.width, height: rendered.info.height };
}

function majorityFilter(labels: Uint16Array, w: number, h: number, radius: number): Uint16Array {
  if (radius <= 1) return labels;
  const r = Math.max(1, Math.floor(radius / 2));
  const out = new Uint16Array(labels.length);
  const bins = new Uint32Array(64);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      bins.fill(0);
      let best = labels[y * w + x] ?? 0;
      let bestN = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const v = labels[yy * w + xx] ?? 0;
          if (!v || v >= bins.length) continue;
          bins[v] = (bins[v] ?? 0) + 1;
          if (bins[v]! > bestN) {
            bestN = bins[v]!;
            best = v;
          }
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

function fillSmallHoles(labels: Uint16Array, w: number, h: number): void {
  const seen = new Uint8Array(labels.length);
  const stack: number[] = [];
  const pushBg = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (seen[i] || labels[i]) return;
    seen[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) {
    pushBg(x, 0);
    pushBg(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    pushBg(0, y);
    pushBg(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    pushBg(x - 1, y);
    pushBg(x + 1, y);
    pushBg(x, y - 1);
    pushBg(x, y + 1);
  }
  let opaque = 0;
  for (const v of labels) if (v) opaque++;
  const maxArea = Math.max(2, Math.floor(opaque * 0.0005));
  const visited = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] || seen[i] || visited[i]) continue;
    const comp: number[] = [];
    const q = [i];
    visited[i] = 1;
    while (q.length) {
      const cur = q.pop()!;
      comp.push(cur);
      const x = cur % w;
      const y = (cur / w) | 0;
      for (const n of [cur - 1, cur + 1, cur - w, cur + w]) {
        if (n < 0 || n >= labels.length) continue;
        if (x === 0 && n === cur - 1) continue;
        if (x === w - 1 && n === cur + 1) continue;
        if (labels[n] || seen[n] || visited[n]) continue;
        visited[n] = 1;
        q.push(n);
      }
    }
    if (comp.length > maxArea) continue;
    const tally = new Map<number, number>();
    for (const idx of comp) {
      const x = idx % w;
      const y = (idx / w) | 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const v = labels[ny * w + nx] ?? 0;
        if (!v) continue;
        tally.set(v, (tally.get(v) ?? 0) + 1);
      }
    }
    let fill = 1;
    let best = 0;
    for (const [k, n] of tally) {
      if (n > best) {
        best = n;
        fill = k;
      }
    }
    for (const idx of comp) labels[idx] = fill;
  }
}

function dropIslands(labels: Uint16Array, w: number, h: number, minCells: number): void {
  const seen = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i] || seen[i]) continue;
    const color = labels[i]!;
    const comp: number[] = [];
    const q = [i];
    seen[i] = 1;
    while (q.length) {
      const cur = q.pop()!;
      comp.push(cur);
      const x = cur % w;
      for (const n of [cur - 1, cur + 1, cur - w, cur + w]) {
        if (n < 0 || n >= labels.length) continue;
        if (x === 0 && n === cur - 1) continue;
        if (x === w - 1 && n === cur + 1) continue;
        if (seen[n] || labels[n] !== color) continue;
        seen[n] = 1;
        q.push(n);
      }
    }
    if (comp.length < minCells) {
      for (const idx of comp) labels[idx] = 0;
    }
  }
}

async function renderPreview(
  svg: string,
  size: number,
  mat: string,
): Promise<Buffer> {
  const rgb = hexToRgb(mat);
  return sharp(Buffer.from(svg), { density: 288 })
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .flatten({ background: rgb })
    .png()
    .toBuffer();
}

export async function vectorizeDesignAsset(
  opts: AssetScope & { sourceFilename: string } & VectorizeParams,
): Promise<VectorizeResult> {
  const maxColors = opts.maxColors ?? 8;
  if (!Number.isFinite(maxColors) || maxColors < 1 || maxColors > 12) {
    throw new VectorizeError("invalid_params", "invalid_params: maxColors");
  }
  if (opts.snap && opts.snap !== "tokens" && opts.snap !== "tokens+extra") {
    throw new VectorizeError("invalid_params", "invalid_params: snap");
  }
  const src = resolveScopedAsset(opts, opts.sourceFilename);
  const stem = (opts.filename ?? src.name).replace(/\.[^.]+$/, "") || "mark";
  const masterName = opts.filename?.trim()
    ? opts.filename.trim()
    : `${stem}.svg`;
  const validateOnly = /\.svg$/i.test(src.name);
  const paletteResolved = resolvePalette(opts.projectRoot, opts);
  const warnings = [...paletteResolved.warnings];
  const files: VectorizeFile[] = [];
  const outputs: VectorizeReport["outputs"] = [];

  const writeText = (name: string, body: string, kind: VectorizeFile["kind"]) => {
    const out = outPathScoped(opts, name);
    writeFileSync(out.absolutePath, body);
    files.push({
      filename: out.name,
      relativePath: out.relativePath,
      kind,
    });
    return out;
  };

  if (validateOnly) {
    const svg = readFileSync(src.absolutePath, "utf8");
    const checks = await validateDesignSvg(svg, "master", {
      palette: paletteResolved.entries.map((e) => e.hex),
      snap: opts.snap ?? "tokens",
      maxColors,
      square: opts.square,
      padding: opts.padding,
    });
    outputs.push({ filename: src.name, profile: "master", checks });
    const status = validationStatus(checks);
    const report: VectorizeReport = {
      crop: { x: 0, y: 0, w: 0, h: 0 },
      colours: [],
      outputs,
      warnings,
    };
    writeText(
      `${stem}.vectorize.json`,
      `${JSON.stringify(report, null, 2)}\n`,
      "report",
    );
    return {
      op: "vectorize",
      status,
      relativePath: src.relativePath,
      absolutePath: src.absolutePath,
      sourceFilename: src.name,
      summary: `Validated ${src.name} (${status})`,
      files,
      report,
      validateOnly: true,
    };
  }

  const minAlpha = opts.minAlpha ?? 128;
  const loaded = await loadRaster(src.absolutePath);
  const cropped = cropAlpha(loaded.data, loaded.width, loaded.height, minAlpha);
  if (!cropped) {
    throw new VectorizeError("invalid_params", "invalid_params: empty artwork");
  }
  const scaled = await upscale(cropped.data, cropped.width, cropped.height);
  const hist = new Map<number, number>();
  const pixelKeys = new Int32Array(scaled.width * scaled.height);
  pixelKeys.fill(-1);
  for (let i = 0; i < scaled.width * scaled.height; i++) {
    const a = scaled.data[i * 4 + 3]!;
    if (a < minAlpha) continue;
    const mapped = applyColorMap(
      {
        r: scaled.data[i * 4]!,
        g: scaled.data[i * 4 + 1]!,
        b: scaled.data[i * 4 + 2]!,
      },
      opts.colorMap,
      paletteResolved.entries,
    );
    if (!mapped) continue;
    const key = rgbKey(mapped);
    pixelKeys[i] = key;
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  const clustered = clusterColours(
    hist,
    paletteResolved.entries,
    { ...opts, maxColors },
    warnings,
  );
  const removedTargets = new Set(
    clustered
      .filter(
        (c) => applyColorMap(hexToRgb(c.to), opts.colorMap, paletteResolved.entries) === null,
      )
      .map((c) => c.to),
  );
  const clusters = applyClusterColorMap(
    clustered,
    opts.colorMap,
    paletteResolved.entries,
  );
  const labels = new Uint16Array(pixelKeys.length);
  const assign = new Map<number, number>();
  for (const [key] of hist) {
    const lab = srgbToLab(keyToRgb(key));
    let bestAll = clustered[0];
    let bestAllD = Infinity;
    for (const cluster of clustered) {
      const d = deltaE00(lab, srgbToLab(hexToRgb(cluster.to)));
      if (d < bestAllD) {
        bestAllD = d;
        bestAll = cluster;
      }
    }
    if (bestAll && removedTargets.has(bestAll.to)) {
      assign.set(key, 0);
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const d = deltaE00(lab, srgbToLab(hexToRgb(clusters[i]!.to)));
      if (d < bestD) {
        bestD = d;
        best = i + 1;
      }
    }
    assign.set(key, best);
  }
  for (let i = 0; i < pixelKeys.length; i++) {
    const key = pixelKeys[i]!;
    if (key < 0) continue;
    labels[i] = assign.get(key) ?? 0;
  }
  const filtered = majorityFilter(labels, scaled.width, scaled.height, opts.modeFilterPx ?? 5);
  fillSmallHoles(filtered, scaled.width, scaled.height);
  applyDropRegions(filtered, scaled.width, scaled.height, opts.dropRegions, clusters, false);

  const total = filtered.reduce((n, v) => n + (v ? 1 : 0), 0) || 1;
  const colours = clusters.map((c, i) => {
    let count = 0;
    for (const v of filtered) if (v === i + 1) count++;
    return {
      from: rgbToHex(keyToRgb(c.key)),
      to: c.to,
      token: c.token,
      deltaE: Math.round(c.deltaE * 100) / 100,
      share: Math.round((count / total) * 1000) / 1000,
    };
  });

  const order = clusters
    .map((c, i) => ({ i: i + 1, count: colours[i]?.share ?? 0, hex: c.to, token: c.token }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  const traceLayer = async (
    labelImage: Uint16Array,
    w: number,
    h: number,
    orderIds: number[],
    variant: boolean,
  ): Promise<Array<{ hex: string; token?: string; d: string }>> => {
    const layers: Array<{ hex: string; token?: string; d: string }> = [];
    for (let li = 0; li < orderIds.length; li++) {
      const id = orderIds[li]!;
      const above = new Set(orderIds.slice(li));
      const bits = new Uint8Array(w * h);
      let any = false;
      for (let p = 0; p < labelImage.length; p++) {
        if (above.has(labelImage[p]!)) {
          bits[p] = 1;
          any = true;
        }
      }
      if (!any) continue;
      const turd =
        opts.potrace?.turdsize ??
        (variant ? 2 : Math.max(2, Math.round((w * h) / 80000)));
      const args = variant
        ? ["-a", "1.1", "-O", "1.0", "-t", "2", "-u", "4"]
        : [
            "-a",
            String(opts.potrace?.alphamax ?? 0.6),
            "-O",
            String(opts.potrace?.opttolerance ?? 0.4),
            "-t",
            String(turd),
            "-u",
            "4",
          ];
      const traced = await tracePbm(bits, w, h, args);
      const cluster = clusters[id - 1];
      const d = potracePathsToCrop(traced, w, h, cropped.width, cropped.height);
      if (!d) continue;
      layers.push({ hex: cluster?.to ?? "#000000", token: cluster?.token, d });
    }
    return layers;
  };

  const masterLayers = await traceLayer(
    filtered,
    scaled.width,
    scaled.height,
    order.map((o) => o.i),
    false,
  );
  let masterSvg = applySquarePadding(
    assembleSvg(stem, masterLayers, {
      x: 0,
      y: 0,
      w: cropped.width,
      h: cropped.height,
    }),
    cropped.width,
    cropped.height,
    opts.square !== false,
    opts.padding ?? 0,
  );

  const refPng = await sharp(cropped.data, {
    raw: { width: cropped.width, height: cropped.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const paletteHexes = paletteResolved.entries.map((e) => e.hex);
  const masterChecks = await validateDesignSvg(masterSvg, "master", {
    palette: paletteHexes,
    reference: refPng,
    snap: opts.snap ?? "tokens",
    maxColors,
    square: opts.square !== false,
    padding: opts.padding ?? 0,
  });
  const statuses: VectorizeStatus[] = [validationStatus(masterChecks)];
  const masterFileName =
    statuses[0] === "failed" ? `${stem}.failed.svg` : masterName.endsWith(".svg") ? masterName : `${stem}.svg`;
  if (statuses[0] === "failed") {
    const existing = outPathScoped(opts, masterName.endsWith(".svg") ? masterName : `${stem}.svg`);
    if (existsSync(existing.absolutePath)) {
      /* keep a passing master in place */
    }
  }
  outputs.push({
    filename: masterFileName,
    profile: "master",
    checks: masterChecks,
  });
  const masterOut = writeText(masterFileName, masterSvg, "svg");

  const variantSizes = opts.variants ?? [32, 16];
  const variantSvgs = new Map<number, string>();
  for (const px of variantSizes) {
    const grid = px * 4;
    const down = await downsampleLabels(filtered, scaled.width, scaled.height, grid);
    applyVariantOps(down.labels, down.width, down.height, clusters, opts);
    applyDropRegions(down.labels, down.width, down.height, opts.dropRegions, clusters, true);
    fillSmallHoles(down.labels, down.width, down.height);
    dropIslands(down.labels, down.width, down.height, 2);
    const ids = [...new Set(down.labels.filter((v) => v))].sort((a, b) => {
      const ca = down.labels.reduce((n, v) => n + (v === a ? 1 : 0), 0);
      const cb = down.labels.reduce((n, v) => n + (v === b ? 1 : 0), 0);
      return cb - ca;
    });
    const layers = await traceLayer(down.labels, down.width, down.height, ids, true);
    let svg = applySquarePadding(
      assembleSvg(`${stem}-${px}`, layers, {
        x: 0,
        y: 0,
        w: cropped.width,
        h: cropped.height,
      }),
      cropped.width,
      cropped.height,
      opts.square !== false,
      opts.padding ?? 0,
    );
    const profile = px <= 16 ? "micro" : "small";
    const checks = await validateDesignSvg(svg, profile, {
      palette: paletteHexes,
      snap: opts.snap ?? "tokens",
      maxColors,
      square: opts.square !== false,
      padding: opts.padding ?? 0,
    });
    const st = validationStatus(checks);
    statuses.push(st);
    const name = `${stem}-${px}.svg`;
    outputs.push({ filename: name, profile, checks });
    writeText(name, svg, "svg");
    variantSvgs.set(px, svg);
    if (st === "failed") warnings.push(`variant_failed:${px}`);
  }

  const mats = {
    dark: opts.mats?.dark ?? "#111111",
    light: opts.mats?.light ?? "#FFFFFF",
  };
  const previewSizes = opts.previewSizes ?? [16, 32, 64, 256];
  const previewBufs: Array<{ name: string; buf: Buffer }> = [];
  for (const size of previewSizes) {
    const svg =
      size <= 16
        ? variantSvgs.get(16) ?? masterSvg
        : size <= 32
          ? variantSvgs.get(32) ?? masterSvg
          : masterSvg;
    for (const [matName, mat] of [
      ["dark", mats.dark],
      ["light", mats.light],
    ] as const) {
      const name = `${stem}-preview-${size}-${matName}.png`;
      const buf = await renderPreview(svg, size, mat);
      const out = outPathScoped(opts, name);
      writeFileSync(out.absolutePath, buf);
      files.push({
        filename: name,
        relativePath: out.relativePath,
        size,
        kind: "preview",
      });
      previewBufs.push({ name, buf });
    }
  }

  const sheet = await contactSheet(previewBufs, colours.map((c) => c.to), outputs);
  const sheetOut = outPathScoped(opts, `${stem}-contact-sheet.png`);
  writeFileSync(sheetOut.absolutePath, sheet);
  files.push({
    filename: sheetOut.name,
    relativePath: sheetOut.relativePath,
    kind: "sheet",
  });

  const status = worstStatus(statuses);
  const report: VectorizeReport = {
    crop: {
      x: cropped.x,
      y: cropped.y,
      w: cropped.width,
      h: cropped.height,
    },
    colours,
    outputs,
    warnings: [...new Set(warnings)],
  };
  writeText(`${stem}.vectorize.json`, `${JSON.stringify(report, null, 2)}\n`, "report");
  const pathCount = (masterSvg.match(/<path\b/g) ?? []).length;
  const fillCount = new Set(
    [...masterSvg.matchAll(/fill="(#[0-9A-Fa-f]+)"/g)].map((m) => m[1]),
  ).size;
  return {
    op: "vectorize",
    status,
    relativePath: masterOut.relativePath,
    absolutePath: masterOut.absolutePath,
    sourceFilename: src.name,
    summary: `Vectorized ${src.name} → ${masterOut.name} (${pathCount} paths, ${fillCount} fills)`,
    files,
    report,
  };
}

function applyDropRegions(
  labels: Uint16Array,
  w: number,
  h: number,
  regions: VectorizeParams["dropRegions"],
  clusters: Cluster[],
  variantsOnlyPass: boolean,
): void {
  if (!regions?.length) return;
  for (const region of regions) {
    if (Boolean(region.variantsOnly) !== variantsOnlyPass) continue;
    const x0 = Math.max(0, Math.floor(region.x * w));
    const y0 = Math.max(0, Math.floor(region.y * h));
    const x1 = Math.min(w, Math.ceil((region.x + region.w) * w));
    const y1 = Math.min(h, Math.ceil((region.y + region.h) * h));
    let into = 0;
    if (region.into && region.into !== "transparent") {
      const hex = normalizeHex(region.into);
      const idx = clusters.findIndex((c) => c.to === hex);
      if (idx >= 0) into = idx + 1;
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) labels[y * w + x] = into;
    }
  }
}

async function downsampleLabels(
  labels: Uint16Array,
  w: number,
  h: number,
  grid: number,
): Promise<{ labels: Uint16Array; width: number; height: number }> {
  const side = grid;
  const out = new Uint16Array(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const tally = new Map<number, number>();
      const x0 = Math.floor((x * w) / side);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / side));
      const y0 = Math.floor((y * h) / side);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / side));
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const v = labels[yy * w + xx] ?? 0;
          if (!v) continue;
          tally.set(v, (tally.get(v) ?? 0) + 1);
        }
      }
      let best = 0;
      let n = 0;
      for (const [k, c] of tally) {
        if (c > n) {
          n = c;
          best = k;
        }
      }
      out[y * side + x] = best;
    }
  }
  return { labels: out, width: side, height: side };
}

function applyVariantOps(
  labels: Uint16Array,
  w: number,
  h: number,
  clusters: Cluster[],
  params: VectorizeParams,
): void {
  const idOf = (hexes: string[] | undefined): number[] => {
    if (!hexes?.length) return [];
    const wanted = new Set(hexes.map((h) => normalizeHex(h)).filter(Boolean));
    return clusters
      .map((c, i) => (wanted.has(c.to) ? i + 1 : 0))
      .filter((n) => n > 0);
  };
  const drop = new Set(idOf(params.variantDrop));
  if (drop.size) {
    const counts = new Map<number, number>();
    for (const v of labels) if (v && !drop.has(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
    let under = 0;
    let best = 0;
    for (const [k, n] of counts) {
      if (n > best) {
        best = n;
        under = k;
      }
    }
    if (under) {
      for (let i = 0; i < labels.length; i++) {
        if (drop.has(labels[i]!)) labels[i] = under;
      }
    }
  }
  const thicken = new Set(idOf(params.variantThicken));
  if (!thicken.size) return;
  const next = labels.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = labels[y * w + x] ?? 0;
      if (!thicken.has(v)) continue;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const cur = labels[ny * w + nx] ?? 0;
        if (cur && cur !== v) next[ny * w + nx] = v;
      }
    }
  }
  labels.set(next);
}

async function contactSheet(
  previews: Array<{ name: string; buf: Buffer }>,
  swatches: string[],
  outputs: VectorizeReport["outputs"],
): Promise<Buffer> {
  const tile = 64;
  const cols = 4;
  const rows = Math.max(1, Math.ceil(previews.length / cols));
  const width = cols * tile;
  const height = rows * tile + 36;
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let i = 0; i < previews.length; i++) {
    const buf = await sharp(previews[i]!.buf)
      .resize(tile, tile, { fit: "contain", background: "#FFFFFF" })
      .png()
      .toBuffer();
    composites.push({
      input: buf,
      left: (i % cols) * tile,
      top: Math.floor(i / cols) * tile + 36,
    });
  }
  const failing = outputs
    .flatMap((o) => o.checks.filter((c) => !c.ok).map((c) => `${o.filename}:${c.id}`))
    .slice(0, 6)
    .join(" ");
  const swatchRects = swatches
    .slice(0, 8)
    .map(
      (hex, i) =>
        `<rect x="${4 + i * 18}" y="4" width="14" height="14" fill="${hex}"/>`,
    )
    .join("");
  const caption = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="36"><rect width="100%" height="100%" fill="#FFFFFF"/>${swatchRects}<text x="4" y="32" font-size="10" fill="#111111">${escapeXml(failing || "checks ok")}</text></svg>`,
  );
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#FFFFFF",
    },
  })
    .composite([{ input: caption, left: 0, top: 0 }, ...composites])
    .png()
    .toBuffer();
}
