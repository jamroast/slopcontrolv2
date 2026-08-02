/**
 * Read-only extraction of per-screen UI copy and domain entity fields
 * for design-loop mocks. Deterministic — no LLM.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type ScreenContent = {
  route: string;
  source: string;
  headings: string[];
  buttons: string[];
  tableColumns: string[];
  formFields: string[];
  copy: string[];
};

export type EntityFieldGroup = {
  name: string;
  source: string;
  fields: string[];
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  ".cache",
  "out",
  ".slopcontrol",
]);

const NOISE_RE =
  /^(import|export|from|className|http|\/|#|\.|px-|flex|grid|text-|bg-|border-|sm:|md:|lg:|xl:|var\(|rgba?\(|#[0-9a-f]{3,8}$)/i;

function toProjectRelative(projectRoot: string, abs: string): string {
  return relative(projectRoot, abs).replace(/\\/g, "/");
}

function walkFiles(
  root: string,
  dir: string,
  out: string[],
  maxFiles: number,
  depth = 0,
): void {
  if (out.length >= maxFiles || depth > 8) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= maxFiles) return;
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(root, full, out, maxFiles, depth + 1);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
}

function cleanText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulCopy(s: string): boolean {
  if (!s || s.length < 2 || s.length > 120) return false;
  if (NOISE_RE.test(s)) return false;
  if (/^[{}[\]();,:]+$/.test(s)) return false;
  if (!/[a-zA-Z]{2,}/.test(s)) return false;
  return true;
}

function pushUnique(arr: string[], value: string, max: number): void {
  const v = value.trim();
  if (!isUsefulCopy(v)) return;
  if (arr.includes(v)) return;
  if (arr.length >= max) return;
  arr.push(v);
}

/** Pure extractor: headings / buttons / table columns / form fields / copy from JSX source. */
export function extractScreenContentFromSource(
  source: string,
  body: string,
  route = "/",
): ScreenContent {
  const headings: string[] = [];
  {
    const re = /<(h[1-3])(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null && headings.length < 12) {
      pushUnique(headings, cleanText(m[2] ?? ""), 12);
    }
  }

  const tableColumns: string[] = [];
  {
    const re = /<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null && tableColumns.length < 16) {
      pushUnique(tableColumns, cleanText(m[1] ?? ""), 16);
    }
  }

  const buttons: string[] = [];
  {
    const re = /<(?:button|Button)(?:\s[^>]*)?>([\s\S]*?)<\/(?:button|Button)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null && buttons.length < 16) {
      pushUnique(buttons, cleanText(m[1] ?? ""), 16);
    }
  }

  const formFields: string[] = [];
  {
    const labelRe = /<label(?:\s[^>]*)?>([\s\S]*?)<\/label>/gi;
    let m: RegExpExecArray | null;
    while ((m = labelRe.exec(body)) !== null && formFields.length < 20) {
      pushUnique(formFields, cleanText(m[1] ?? ""), 20);
    }
    const phRe = /placeholder\s*=\s*["'`]([^"'`]{2,80})["'`]/gi;
    while ((m = phRe.exec(body)) !== null && formFields.length < 20) {
      pushUnique(formFields, (m[1] ?? "").trim(), 20);
    }
  }

  const copy: string[] = [];
  {
    const textRe =
      /<(?:p|span|li|dt|dd|CardTitle|CardDescription)(?:\s[^>]*)?>([\s\S]*?)<\//gi;
    let m: RegExpExecArray | null;
    while ((m = textRe.exec(body)) !== null && copy.length < 20) {
      pushUnique(copy, cleanText(m[1] ?? ""), 20);
    }
    // Quoted-string fallback (same spirit as excerptLandingCopy).
    if (copy.length < 8) {
      const strings = [...body.matchAll(/["'`]([^"'`]{8,120})["'`]/g)]
        .map((x) => (x[1] ?? "").trim())
        .filter(isUsefulCopy);
      for (const s of strings) {
        if (
          headings.includes(s) ||
          buttons.includes(s) ||
          tableColumns.includes(s) ||
          formFields.includes(s)
        ) {
          continue;
        }
        pushUnique(copy, s, 20);
        if (copy.length >= 20) break;
      }
    }
  }

  return {
    route,
    source,
    headings,
    buttons,
    tableColumns,
    formFields,
    copy,
  };
}

/** Pure extractor: interface / type / zod / prisma field names. */
export function extractEntityFieldsFromSource(
  source: string,
  body: string,
): EntityFieldGroup[] {
  const out: EntityFieldGroup[] = [];
  const seen = new Set<string>();

  const pushGroup = (name: string, fields: string[]) => {
    const clean = fields
      .map((f) => f.trim())
      .filter((f) => /^[A-Za-z_][\w]*$/.test(f))
      .slice(0, 16);
    if (!clean.length) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, source, fields: clean });
  };

  // interface Foo { a: string; b?: number }
  {
    const re = /(?:export\s+)?interface\s+([A-Z][A-Za-z0-9_]*)\s*\{([^}]{0,2000})\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null && out.length < 12) {
      const fields = [...(m[2] ?? "").matchAll(/^\s*([A-Za-z_][\w]*)\s*[?:]/gm)].map(
        (x) => x[1]!,
      );
      pushGroup(m[1]!, fields);
    }
  }

  // type Foo = { a: string }
  {
    const re =
      /(?:export\s+)?type\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\{([^}]{0,2000})\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null && out.length < 12) {
      const fields = [...(m[2] ?? "").matchAll(/^\s*([A-Za-z_][\w]*)\s*[?:]/gm)].map(
        (x) => x[1]!,
      );
      pushGroup(m[1]!, fields);
    }
  }

  // z.object({ a: z.string(), b: z.number() })
  {
    const re = /z\.object\(\s*\{([^}]{0,2000})\}/g;
    let m: RegExpExecArray | null;
    let anon = 0;
    while ((m = re.exec(body)) !== null && out.length < 12) {
      const fields = [...(m[1] ?? "").matchAll(/^\s*([A-Za-z_][\w]*)\s*:/gm)].map(
        (x) => x[1]!,
      );
      // Prefer nearby const Name = z.object
      const before = body.slice(Math.max(0, (m.index ?? 0) - 80), m.index);
      const named = before.match(
        /(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*$/,
      );
      const name = named?.[1] ?? `ZodObject${++anon}`;
      pushGroup(name, fields);
    }
  }

  // prisma model Invoice { id String ... }
  if (/model\s+[A-Z]/.test(body) || source.endsWith(".prisma")) {
    const re = /model\s+([A-Z][A-Za-z0-9_]*)\s*\{([^}]{0,3000})\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null && out.length < 12) {
      const fields = [...(m[2] ?? "").matchAll(/^\s*([a-zA-Z_][\w]*)\s+[A-Za-z]/gm)]
        .map((x) => x[1]!)
        .filter((f) => !["@@", "//"].some((p) => f.startsWith(p)));
      pushGroup(m[1]!, fields);
    }
  }

  return out.slice(0, 12);
}

/**
 * Map a page file path to an App Router route string.
 * Exported for reuse by live-site-inventory collectRoutes.
 */
export function routeFromPageFile(
  projectRoot: string,
  absOrRel: string,
): string | null {
  const rel = absOrRel.startsWith(projectRoot)
    ? toProjectRelative(projectRoot, absOrRel)
    : absOrRel.replace(/\\/g, "/");
  if (!/(^|\/)page\.(tsx|jsx|ts|js)$/i.test(rel)) return null;
  if (rel.includes("/api/")) return null;
  let path = rel
    .replace(/^src\/app\//, "/")
    .replace(/^app\//, "/")
    .replace(/\/page\.(tsx|jsx|ts|js)$/i, "")
    .replace(/\\/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/" || path === "") return "/";
  path = path
    .split("/")
    .filter((seg) => seg && !/^\(.*\)$/.test(seg))
    .join("/");
  path = path
    .replace(/\/\[\.\.\.[^\]]+\]/g, "")
    .replace(/\/\[[^\]]+\]/g, "/:param");
  if (!path.startsWith("/")) path = `/${path}`;
  return path || "/";
}

/** List page files with their routes (sorted by route). */
export function collectRouteFiles(
  projectRoot: string,
  files?: string[],
): Array<{ abs: string; route: string; source: string }> {
  const scanned = files ?? [];
  if (!scanned.length) {
    for (const sub of ["src", "app", "components"]) {
      const d = join(projectRoot, sub);
      if (existsSync(d)) walkFiles(projectRoot, d, scanned, 500);
    }
  }
  const out: Array<{ abs: string; route: string; source: string }> = [];
  const seen = new Set<string>();
  for (const abs of scanned) {
    const route = routeFromPageFile(projectRoot, abs);
    if (!route) continue;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push({
      abs,
      route,
      source: toProjectRelative(projectRoot, abs),
    });
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

function resolveLocalImport(
  projectRoot: string,
  fromFile: string,
  spec: string,
): string | null {
  let candidate: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    candidate = resolve(dirname(fromFile), spec);
  } else if (spec.startsWith("@/")) {
    candidate = join(projectRoot, "src", spec.slice(2));
  } else if (spec.startsWith("~/")) {
    candidate = join(projectRoot, "src", spec.slice(2));
  } else {
    return null;
  }
  const tries = [
    candidate,
    `${candidate}.tsx`,
    `${candidate}.ts`,
    `${candidate}.jsx`,
    `${candidate}.js`,
    join(candidate, "index.tsx"),
    join(candidate, "index.ts"),
  ];
  for (const t of tries) {
    if (existsSync(t) && statSync(t).isFile()) return t;
  }
  return null;
}

function oneHopImports(
  projectRoot: string,
  pageAbs: string,
  body: string,
  max = 8,
): string[] {
  const specs = [
    ...body.matchAll(
      /from\s+["']((?:\.\.?\/|@\/|~\/)[^"']+)["']/g,
    ),
  ].map((m) => m[1]!).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>([resolve(pageAbs)]);
  for (const spec of specs) {
    if (out.length >= max) break;
    const abs = resolveLocalImport(projectRoot, pageAbs, spec);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function mergeScreenContent(into: ScreenContent, from: ScreenContent): void {
  for (const h of from.headings) pushUnique(into.headings, h, 12);
  for (const b of from.buttons) pushUnique(into.buttons, b, 16);
  for (const c of from.tableColumns) pushUnique(into.tableColumns, c, 16);
  for (const f of from.formFields) pushUnique(into.formFields, f, 20);
  for (const c of from.copy) pushUnique(into.copy, c, 20);
}

function screenHasSignal(s: ScreenContent): boolean {
  return (
    s.headings.length +
      s.buttons.length +
      s.tableColumns.length +
      s.formFields.length +
      s.copy.length >
    0
  );
}

function collectEntityFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const roots = [
    join(projectRoot, "src"),
    join(projectRoot, "src", "lib"),
    join(projectRoot, "src", "lib", "validations"),
    join(projectRoot, "src", "types"),
    join(projectRoot, "prisma"),
  ];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    walkFiles(projectRoot, dir, files, 200);
    for (const abs of files) {
      const base = basename(abs);
      if (
        /(types|models?|schema|validations?)\.(ts|tsx|js|prisma)$/i.test(base) ||
        abs.endsWith("schema.prisma")
      ) {
        out.push(abs);
      }
      if (out.length >= 40) return out;
    }
  }
  return out;
}

/** Build per-route screen content + domain entity fields (read-only). */
export function buildScreenContentInventory(projectRoot: string): {
  screens: ScreenContent[];
  entities: EntityFieldGroup[];
} {
  if (!existsSync(projectRoot)) {
    return { screens: [], entities: [] };
  }

  const routeFiles = collectRouteFiles(projectRoot);
  const screens: ScreenContent[] = [];
  for (const rf of routeFiles.slice(0, 40)) {
    let body = "";
    try {
      body = readFileSync(rf.abs, "utf-8");
    } catch {
      continue;
    }
    const screen = extractScreenContentFromSource(rf.source, body, rf.route);
    for (const hop of oneHopImports(projectRoot, rf.abs, body, 8)) {
      try {
        const hopBody = readFileSync(hop, "utf-8");
        const hopSource = toProjectRelative(projectRoot, hop);
        mergeScreenContent(
          screen,
          extractScreenContentFromSource(hopSource, hopBody, rf.route),
        );
      } catch {
        /* skip unreadable */
      }
    }
    if (screenHasSignal(screen)) screens.push(screen);
  }

  const entities: EntityFieldGroup[] = [];
  const seenEntity = new Set<string>();
  for (const abs of collectEntityFiles(projectRoot)) {
    let body = "";
    try {
      body = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const source = toProjectRelative(projectRoot, abs);
    for (const g of extractEntityFieldsFromSource(source, body)) {
      const key = g.name.toLowerCase();
      if (seenEntity.has(key)) continue;
      seenEntity.add(key);
      entities.push(g);
      if (entities.length >= 12) break;
    }
    if (entities.length >= 12) break;
  }

  return { screens, entities };
}
