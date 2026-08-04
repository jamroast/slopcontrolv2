/**
 * Shared design elements — versioned controls/patterns (spec + mock + optional TS/JS).
 *
 * Origins (same artifact shape):
 *   A/C — project library: <project>/.slopcontrol/elements/
 *   B   — global registry: <dataDir>/shared-elements/
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  designLoopDir,
  readDesignLoopMeta,
  readDesignLoopMockHtml,
  writeDesignLoopMeta,
  type DesignLoopMeta,
} from "./design-loop.js";
import { resolveShareAlias } from "./design-share.js";
import { pinDesignLoopSelection } from "./design-loop-selections.js";
import {
  jamPackageNameForElement,
  scaffoldElementNpmPackage,
} from "./npm-registry.js";

const SLOP_DIR = ".slopcontrol";

export const DesignElementKindSchema = z.enum(["control", "shell", "pattern"]);
export type DesignElementKind = z.infer<typeof DesignElementKindSchema>;

export const DesignElementOriginSchema = z.enum(["project", "registry"]);
export type DesignElementOrigin = z.infer<typeof DesignElementOriginSchema>;

export const DesignElementMetaSchema = z.object({
  id: z.string().min(1),
  kind: DesignElementKindSchema,
  label: z.string().min(1),
  version: z.number().int().positive(),
  states: z.array(z.string()).default([]),
  a11y: z.array(z.string()).default([]),
  mountHints: z.array(z.string()).default([]),
  themeRequirements: z.array(z.string()).default([]),
  deps: z.array(z.string()).default([]),
  hasCode: z.boolean().default(false),
  status: z.enum(["draft", "published"]).default("published"),
  sourceProjectId: z.string().optional(),
  sourceRootPath: z.string().optional(),
  /** Published npm package name when bridged to the private registry. */
  npmPackage: z.string().optional(),
  npmVersion: z.string().optional(),
  publishedAt: z.string(),
  updatedAt: z.string(),
});
export type DesignElementMeta = z.infer<typeof DesignElementMetaSchema>;

export const DesignElementRefSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  origin: DesignElementOriginSchema,
  /** Project root when origin=project (absolute). */
  sourceRootPath: z.string().optional(),
  sourceName: z.string().optional(),
  label: z.string().optional(),
  kind: DesignElementKindSchema.optional(),
  mountHints: z.array(z.string()).default([]),
  hasCode: z.boolean().default(false),
  /** Loop-relative or phase-relative paths after import. */
  mockPath: z.string().optional(),
  specPath: z.string().optional(),
  codePath: z.string().optional(),
  pinnedAt: z.string().optional(),
  npmPackage: z.string().optional(),
  npmVersion: z.string().optional(),
});
export type DesignElementRef = z.infer<typeof DesignElementRefSchema>;

export const DesignElementIndexEntrySchema = z.object({
  id: z.string(),
  latestVersion: z.number().int().positive(),
  kind: DesignElementKindSchema,
  label: z.string(),
  status: z.enum(["draft", "published"]),
  hasCode: z.boolean().default(false),
  updatedAt: z.string(),
  npmPackage: z.string().optional(),
  npmVersion: z.string().optional(),
});
export type DesignElementIndexEntry = z.infer<
  typeof DesignElementIndexEntrySchema
>;

export const DesignElementIndexSchema = z.object({
  updatedAt: z.string(),
  elements: z.array(DesignElementIndexEntrySchema).default([]),
});
export type DesignElementIndex = z.infer<typeof DesignElementIndexSchema>;

export type DesignElementBundle = {
  meta: DesignElementMeta;
  spec: string;
  mockHtml: string;
  tokensCss: string;
  /** Relative paths under src/ → file contents */
  srcFiles: Record<string, string>;
  rootPath: string;
};

function slugElementId(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "element"
  );
}

export function projectElementsRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR, "elements");
}

export function registryElementsRoot(dataDir: string): string {
  return join(dataDir, "shared-elements");
}

export function elementVersionDir(
  libraryRoot: string,
  elementId: string,
  version: number,
): string {
  return join(libraryRoot, elementId, `v${version}`);
}

export function elementIndexPath(libraryRoot: string): string {
  return join(libraryRoot, "INDEX.json");
}

export function readElementIndex(libraryRoot: string): DesignElementIndex {
  const path = elementIndexPath(libraryRoot);
  if (!existsSync(path)) {
    return { updatedAt: new Date().toISOString(), elements: [] };
  }
  try {
    return DesignElementIndexSchema.parse(
      JSON.parse(readFileSync(path, "utf-8")),
    );
  } catch {
    return { updatedAt: new Date().toISOString(), elements: [] };
  }
}

function writeElementIndex(
  libraryRoot: string,
  index: DesignElementIndex,
): void {
  mkdirSync(libraryRoot, { recursive: true });
  writeFileSync(
    elementIndexPath(libraryRoot),
    `${JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );
}

function upsertIndexEntry(
  libraryRoot: string,
  meta: DesignElementMeta,
): void {
  const index = readElementIndex(libraryRoot);
  const next: DesignElementIndexEntry = {
    id: meta.id,
    latestVersion: meta.version,
    kind: meta.kind,
    label: meta.label,
    status: meta.status,
    hasCode: meta.hasCode,
    updatedAt: meta.updatedAt,
    npmPackage: meta.npmPackage,
    npmVersion: meta.npmVersion,
  };
  const others = index.elements.filter((e) => e.id !== meta.id);
  writeElementIndex(libraryRoot, {
    updatedAt: meta.updatedAt,
    elements: [...others, next].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function readSrcTree(srcDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(srcDir)) return out;
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile() && st.size < 400_000) {
        try {
          out[rel] = readFileSync(full, "utf-8");
        } catch {
          /* skip binary */
        }
      }
    }
  };
  walk(srcDir, "");
  return out;
}

function writeSrcTree(srcDir: string, files: Record<string, string>): void {
  mkdirSync(srcDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(srcDir, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body, "utf-8");
  }
}

export function readDesignElementBundle(
  libraryRoot: string,
  elementId: string,
  version: number,
): DesignElementBundle | null {
  const dir = elementVersionDir(libraryRoot, elementId, version);
  const metaPath = join(dir, "ELEMENT.json");
  if (!existsSync(metaPath)) return null;
  try {
    const meta = DesignElementMetaSchema.parse(
      JSON.parse(readFileSync(metaPath, "utf-8")),
    );
    const spec = existsSync(join(dir, "SPEC.md"))
      ? readFileSync(join(dir, "SPEC.md"), "utf-8")
      : "";
    const mockHtml = existsSync(join(dir, "mock.html"))
      ? readFileSync(join(dir, "mock.html"), "utf-8")
      : "";
    const tokensCss = existsSync(join(dir, "tokens.css"))
      ? readFileSync(join(dir, "tokens.css"), "utf-8")
      : "";
    return {
      meta,
      spec,
      mockHtml,
      tokensCss,
      srcFiles: readSrcTree(join(dir, "src")),
      rootPath: dir,
    };
  } catch {
    return null;
  }
}

export function listProjectElements(
  projectRoot: string,
): DesignElementIndexEntry[] {
  return readElementIndex(projectElementsRoot(projectRoot)).elements;
}

export function listRegistryElements(dataDir: string): DesignElementIndexEntry[] {
  return readElementIndex(registryElementsRoot(dataDir)).elements;
}

export type ResolveDesignElementOpts = {
  elementId: string;
  version?: number;
  /** Explicit: registry | project:<name|id|path> */
  origin?: string;
  targetRoot: string;
  dataDir?: string;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
};

function libraryForOrigin(
  origin: DesignElementOrigin,
  opts: { projectRoot?: string; dataDir?: string },
): string | null {
  if (origin === "registry") {
    return opts.dataDir ? registryElementsRoot(opts.dataDir) : null;
  }
  return opts.projectRoot ? projectElementsRoot(opts.projectRoot) : null;
}

function resolveProjectRootByName(
  name: string,
  targetRoot: string,
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>,
): string | null {
  const want = resolveShareAlias(name).toLowerCase();
  const projects = listProjects?.() ?? [];
  const byStore = projects.find(
    (p) =>
      p.name.toLowerCase() === want ||
      p.name.toLowerCase() === name.toLowerCase() ||
      p.id === name ||
      basename(p.rootPath.replace(/\/$/, "")).toLowerCase() === want,
  );
  if (byStore) return byStore.rootPath;
  const parent = join(targetRoot, "..");
  const candidate = join(parent, resolveShareAlias(name));
  if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Resolve an element id across project libs, registry, aliases, and federated store.
 */
export function resolveDesignElement(
  opts: ResolveDesignElementOpts,
): DesignElementBundle | null {
  const id = slugElementId(opts.elementId);
  const dataDir = opts.dataDir;

  const tryLib = (
    libraryRoot: string | null,
    version?: number,
  ): DesignElementBundle | null => {
    if (!libraryRoot) return null;
    const index = readElementIndex(libraryRoot);
    const entry = index.elements.find((e) => e.id === id);
    const v = version ?? entry?.latestVersion;
    if (!v) return null;
    return readDesignElementBundle(libraryRoot, id, v);
  };

  // 1. Explicit origin
  if (opts.origin?.trim()) {
    const o = opts.origin.trim().toLowerCase();
    if (o === "registry") {
      return tryLib(
        dataDir ? registryElementsRoot(dataDir) : null,
        opts.version,
      );
    }
    const projMatch = o.match(/^project:(.+)$/);
    if (projMatch?.[1]) {
      const nameOrPath = projMatch[1];
      const root = nameOrPath.startsWith("/")
        ? nameOrPath
        : resolveProjectRootByName(
            nameOrPath,
            opts.targetRoot,
            opts.listProjects,
          );
      return root ? tryLib(projectElementsRoot(root), opts.version) : null;
    }
  }

  // 2. Target project library
  const local = tryLib(projectElementsRoot(opts.targetRoot), opts.version);
  if (local) return local;

  // 3. Brand aliases — scan sibling project libs named in common aliases
  for (const alias of [
    "jamroast",
    "jamlight",
    "jampress",
    "burntjam",
    "light-weight-crm-and-invoicing",
    "basic-web-agent",
  ]) {
    const root = resolveProjectRootByName(
      alias,
      opts.targetRoot,
      opts.listProjects,
    );
    if (!root || root === opts.targetRoot) continue;
    const hit = tryLib(projectElementsRoot(root), opts.version);
    if (hit) return hit;
  }

  // 4. Global registry
  if (dataDir) {
    const reg = tryLib(registryElementsRoot(dataDir), opts.version);
    if (reg) return reg;
  }

  // 5. Federated scan of registered projects
  for (const p of opts.listProjects?.() ?? []) {
    if (p.rootPath.replace(/\/$/, "") === opts.targetRoot.replace(/\/$/, "")) {
      continue;
    }
    const hit = tryLib(projectElementsRoot(p.rootPath), opts.version);
    if (hit) return hit;
  }

  return null;
}

export type PublishDesignElementOpts = {
  projectRoot: string;
  elementId: string;
  kind?: DesignElementKind;
  label?: string;
  spec: string;
  mockHtml: string;
  tokensCss?: string;
  srcFiles?: Record<string, string>;
  states?: string[];
  a11y?: string[];
  mountHints?: string[];
  themeRequirements?: string[];
  deps?: string[];
  /** Also copy into ~/.slopcontrol/shared-elements (B). */
  publishToRegistry?: boolean;
  dataDir?: string;
  sourceProjectId?: string;
  status?: "draft" | "published";
};

export function publishDesignElement(
  opts: PublishDesignElementOpts,
): DesignElementMeta {
  const id = slugElementId(opts.elementId);
  const libraryRoot = projectElementsRoot(opts.projectRoot);
  mkdirSync(libraryRoot, { recursive: true });
  const index = readElementIndex(libraryRoot);
  const prior = index.elements.find((e) => e.id === id);
  const version = (prior?.latestVersion ?? 0) + 1;
  const now = new Date().toISOString();
  const srcFiles = opts.srcFiles ?? {};
  const hasCode = Object.keys(srcFiles).length > 0;
  const meta = DesignElementMetaSchema.parse({
    id,
    kind: opts.kind ?? "control",
    label: opts.label?.trim() || id,
    version,
    states: opts.states ?? [],
    a11y: opts.a11y ?? [],
    mountHints: opts.mountHints ?? [],
    themeRequirements: opts.themeRequirements ?? [],
    deps: opts.deps ?? [],
    hasCode,
    status: opts.status ?? "published",
    sourceProjectId: opts.sourceProjectId,
    sourceRootPath: opts.projectRoot,
    publishedAt: now,
    updatedAt: now,
  });

  const dir = elementVersionDir(libraryRoot, id, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ELEMENT.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(dir, "SPEC.md"), opts.spec.trim() + "\n", "utf-8");
  writeFileSync(join(dir, "mock.html"), opts.mockHtml.trim() + "\n", "utf-8");
  if (opts.tokensCss?.trim()) {
    writeFileSync(join(dir, "tokens.css"), opts.tokensCss.trim() + "\n", "utf-8");
  }
  if (hasCode) writeSrcTree(join(dir, "src"), srcFiles);
  if (hasCode) {
    scaffoldElementNpmPackage({
      outDir: join(dir, "npm-package"),
      elementId: id,
      version,
      label: meta.label,
      srcFiles,
      description: meta.label,
    });
  }
  writeFileSync(
    join(dir, "META.json"),
    `${JSON.stringify(
      {
        publishedAt: now,
        sourceProjectId: opts.sourceProjectId,
        sourceRootPath: opts.projectRoot,
        status: meta.status,
      },
      null,
      2,
    )}\n`,
  );
  upsertIndexEntry(libraryRoot, meta);

  if (opts.publishToRegistry && opts.dataDir) {
    const regRoot = registryElementsRoot(opts.dataDir);
    const regDir = elementVersionDir(regRoot, id, version);
    mkdirSync(regDir, { recursive: true });
    for (const name of [
      "ELEMENT.json",
      "SPEC.md",
      "mock.html",
      "tokens.css",
      "META.json",
    ]) {
      const src = join(dir, name);
      if (existsSync(src)) copyFileSync(src, join(regDir, name));
    }
    if (hasCode) {
      const regSrc = join(regDir, "src");
      if (existsSync(regSrc)) rmSync(regSrc, { recursive: true, force: true });
      writeSrcTree(regSrc, srcFiles);
    }
    upsertIndexEntry(regRoot, meta);
  }

  return meta;
}

/** Extract a theme-toggle (or generic control) snippet from full mock HTML. */
export function extractDesignElementFromMock(opts: {
  html: string;
  elementId?: string;
  kind?: DesignElementKind;
  label?: string;
  brief?: string;
}): {
  elementId: string;
  kind: DesignElementKind;
  label: string;
  mockHtml: string;
  spec: string;
  tokensCss: string;
  states: string[];
  a11y: string[];
  mountHints: string[];
  themeRequirements: string[];
  srcFiles: Record<string, string>;
} {
  const html = opts.html ?? "";
  const isTheme =
    /\btheme-toggle\b/i.test(html) ||
    /\bdata-theme\b/i.test(html) ||
    /\b(day|night|dark\s*\/\s*light|theme)\s*toggle\b/i.test(
      opts.brief ?? "",
    ) ||
    /theme\.?toggle/i.test(opts.elementId ?? "");

  const elementId = slugElementId(
    opts.elementId || (isTheme ? "theme-toggle" : "shared-control"),
  );
  const kind: DesignElementKind = opts.kind ?? (isTheme ? "control" : "control");
  const label =
    opts.label?.trim() ||
    (isTheme ? "Theme toggle (day / night)" : elementId);

  // Prefer a marked control node; else a button near theme language.
  let snippet = "";
  const marked =
    html.match(
      /<(?:button|div|label)[^>]*(?:class=["'][^"']*theme-toggle[^"']*["']|data-element=["'][^"']*["'])[^>]*>[\s\S]{0,1200}?<\/(?:button|div|label)>/i,
    )?.[0] ?? "";
  if (marked) snippet = marked;
  else {
    const btn =
      html.match(
        /<button[^>]*>[\s\S]{0,400}?(?:dark|light|day|night|theme)[\s\S]{0,400}?<\/button>/i,
      )?.[0] ?? "";
    snippet = btn;
  }
  if (!snippet.trim()) {
    snippet = isTheme
      ? `<button type="button" class="theme-toggle" aria-label="Toggle dark and light theme" data-element="theme-toggle">Dark / Light</button>
<script>
(function(){
  var root=document.documentElement;
  var btn=document.querySelector('[data-element="theme-toggle"],.theme-toggle');
  if(!btn) return;
  btn.addEventListener('click',function(){
    var next=root.getAttribute('data-theme')==='light'?'dark':'light';
    root.setAttribute('data-theme',next);
  });
})();
</script>`
      : `<div data-element="${elementId}" class="shared-element"><!-- define control --></div>`;
  }

  const styleChunks = [
    ...(html.match(/:root\s*\{[\s\S]*?\n\}/) ?? []),
    ...(html.match(/\[data-theme\s*=\s*["']light["']\]\s*\{[\s\S]*?\n\}/) ?? []),
    ...(html.match(/\.theme-toggle\s*\{[\s\S]*?\n\}/) ?? []),
  ];
  const tokensCss = styleChunks.join("\n\n");

  const mockHtml = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"/>
<title>${label}</title>
<style>
${tokensCss || `:root{--background:#0A0A0A;--foreground:#F5F0E8}[data-theme="light"]{--background:#FDF8F3;--foreground:#1A1510}`}
body{margin:0;font-family:system-ui,sans-serif;background:var(--background);color:var(--foreground);padding:2rem}
.theme-toggle, [data-element]{cursor:pointer}
</style>
</head>
<body>
<header data-mount="menubar">
${snippet}
</header>
</body>
</html>`;

  const states = isTheme
    ? ["dark", "light", "toggle"]
    : ["default"];
  const a11y = isTheme
    ? [
        "Button has accessible name (aria-label or visible text)",
        "Toggle updates html[data-theme] between dark and light",
      ]
    : ["Control is keyboard focusable"];
  const mountHints = isTheme
    ? ["menubar", "header", "topbar"]
    : ["host"];
  const themeRequirements = isTheme
    ? [
        "Toggle must set document.documentElement.dataset.theme (html[data-theme])",
        "Do not invent a second competing theme control when this element is pinned",
      ]
    : [];

  const srcFiles: Record<string, string> = isTheme
    ? {
        "theme-toggle.ts": `/** Plain TS theme toggle — framework apps wrap as needed. */
export type ThemeMode = "dark" | "light";

export function getThemeMode(root: HTMLElement = document.documentElement): ThemeMode {
  return root.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function setThemeMode(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  root.setAttribute("data-theme", mode);
}

export function toggleThemeMode(root: HTMLElement = document.documentElement): ThemeMode {
  const next: ThemeMode = getThemeMode(root) === "light" ? "dark" : "light";
  setThemeMode(next, root);
  return next;
}

export function bindThemeToggle(button: HTMLElement, root: HTMLElement = document.documentElement): () => void {
  const onClick = () => { toggleThemeMode(root); };
  button.addEventListener("click", onClick);
  return () => button.removeEventListener("click", onClick);
}
`,
        "theme-toggle.css": `.theme-toggle {
  appearance: none;
  border: 1px solid color-mix(in oklab, var(--foreground) 35%, transparent);
  background: color-mix(in oklab, var(--background) 80%, var(--foreground));
  color: var(--foreground);
  border-radius: 0.5rem;
  padding: 0.35rem 0.75rem;
  font: inherit;
  cursor: pointer;
}
.theme-toggle:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }
`,
      }
    : {};

  const spec = [
    `# ${label}`,
    "",
    `Element id: \`${elementId}\``,
    `Kind: ${kind}`,
    "",
    "## Behavior",
    isTheme
      ? "- Clicking the control toggles `html[data-theme]` between `dark` and `light`."
      : "- Implement per mock and mount hints.",
    "",
    "## Mount",
    ...mountHints.map((h) => `- ${h}`),
    "",
    "## Accessibility",
    ...a11y.map((a) => `- ${a}`),
    "",
    "## Must not",
    "- Do not invent a competing control when this element is pinned in a design loop.",
    opts.brief?.trim() ? `\n## Source brief\n${opts.brief.trim().slice(0, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    elementId,
    kind,
    label,
    mockHtml,
    spec,
    tokensCss,
    states,
    a11y,
    mountHints,
    themeRequirements,
    srcFiles,
  };
}

export type DesignLoopMetaWithElements = DesignLoopMeta & {
  elements?: DesignElementRef[];
};

export function getDesignLoopElements(
  meta: DesignLoopMeta | null | undefined,
): DesignElementRef[] {
  const raw = (meta as DesignLoopMetaWithElements | null)?.elements;
  return Array.isArray(raw) ? raw : [];
}

export function readDesignLoopElements(
  projectRoot: string,
  loopId: string,
): DesignElementRef[] {
  return getDesignLoopElements(readDesignLoopMeta(projectRoot, loopId));
}

/** Copy element assets into the loop and pin as a selection + META.elements. */
export function importDesignElementIntoLoop(opts: {
  targetRoot: string;
  loopId: string;
  bundle: DesignElementBundle;
  origin: DesignElementOrigin;
  sourceName?: string;
}): DesignElementRef {
  const meta = readDesignLoopMeta(opts.targetRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);

  const elDir = join(
    designLoopDir(opts.targetRoot, opts.loopId),
    "elements",
    opts.bundle.meta.id,
    `v${opts.bundle.meta.version}`,
  );
  mkdirSync(elDir, { recursive: true });
  writeFileSync(
    join(elDir, "ELEMENT.json"),
    `${JSON.stringify(opts.bundle.meta, null, 2)}\n`,
  );
  writeFileSync(join(elDir, "SPEC.md"), opts.bundle.spec.trim() + "\n");
  writeFileSync(join(elDir, "mock.html"), opts.bundle.mockHtml.trim() + "\n");
  if (opts.bundle.tokensCss.trim()) {
    writeFileSync(join(elDir, "tokens.css"), opts.bundle.tokensCss.trim() + "\n");
  }
  if (Object.keys(opts.bundle.srcFiles).length) {
    writeSrcTree(join(elDir, "src"), opts.bundle.srcFiles);
  }

  const base = `.slopcontrol/design-loops/${opts.loopId}/elements/${opts.bundle.meta.id}/v${opts.bundle.meta.version}`;
  const ref = DesignElementRefSchema.parse({
    id: opts.bundle.meta.id,
    version: opts.bundle.meta.version,
    origin: opts.origin,
    sourceRootPath: opts.bundle.meta.sourceRootPath,
    sourceName: opts.sourceName,
    label: opts.bundle.meta.label,
    kind: opts.bundle.meta.kind,
    mountHints: opts.bundle.meta.mountHints,
    hasCode: opts.bundle.meta.hasCode,
    mockPath: `${base}/mock.html`,
    specPath: `${base}/SPEC.md`,
    codePath: opts.bundle.meta.hasCode ? `${base}/src` : undefined,
    pinnedAt: new Date().toISOString(),
  });

  const prior = getDesignLoopElements(meta).filter((e) => e.id !== ref.id);
  const nextMeta: DesignLoopMetaWithElements = {
    ...meta,
    elements: [...prior, ref],
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.targetRoot, nextMeta);

  try {
    pinDesignLoopSelection({
      projectRoot: opts.targetRoot,
      loopId: opts.loopId,
      slot: "element",
      conceptId: `${ref.id}@${ref.version}`,
      label: ref.label || ref.id,
      excerpt: `Shared element ${ref.id} v${ref.version}`,
    });
  } catch {
    /* pin best-effort */
  }

  return ref;
}

export function formatDesignElementsPromptBlock(
  elements: DesignElementRef[] | null | undefined,
  opts?: { projectRoot?: string; loopId?: string },
): string {
  if (!elements?.length) return "";
  const lines: string[] = [
    "## SHARED ELEMENTS (authoritative controls — embed these; do NOT invent competing controls)",
    "",
  ];
  for (const el of elements) {
    lines.push(
      `### ${el.id}@${el.version} (${el.kind ?? "control"}) — ${el.label ?? el.id}`,
    );
    lines.push(`- origin: ${el.origin}${el.sourceName ? ` (${el.sourceName})` : ""}`);
    if (el.mountHints?.length) {
      lines.push(`- mount: ${el.mountHints.join(", ")}`);
    }
    if (el.mockPath) lines.push(`- mock: \`${el.mockPath}\``);
    if (el.specPath) lines.push(`- spec: \`${el.specPath}\``);
    if (el.codePath) lines.push(`- code: \`${el.codePath}\` (prefer mounting this TS/JS)`);
    if (opts?.projectRoot && opts.loopId && el.mockPath) {
      const abs = join(opts.projectRoot, el.mockPath);
      if (existsSync(abs)) {
        const body = readFileSync(abs, "utf-8");
        const snippet =
          body.match(
            /<(?:button|div)[^>]*(?:theme-toggle|data-element)[^>]*>[\s\S]{0,800}?<\/(?:button|div)>/i,
          )?.[0] ?? body.slice(0, 600);
        lines.push("```html");
        lines.push(snippet.trim().slice(0, 800));
        lines.push("```");
      }
    }
    lines.push("");
  }
  lines.push(
    "CRITICAL: When an element is listed here, reuse its markup/behavior. A second invented day/night button is a defect.",
  );
  return lines.join("\n");
}

/** Detect competing theme toggles when theme-toggle element is pinned. */
export function detectPinnedElementDrift(opts: {
  html: string;
  elements: DesignElementRef[];
}): Array<{ code: "element_invented"; detail: string }> {
  const issues: Array<{ code: "element_invented"; detail: string }> = [];
  const hasThemeEl = opts.elements.some(
    (e) => e.id === "theme-toggle" || /theme.?toggle/i.test(e.id),
  );
  if (!hasThemeEl) return issues;
  const html = opts.html ?? "";
  const toggleNodes =
    html.match(
      /<(?:button|div|label|a)[^>]*>[\s\S]{0,200}?(?:dark\s*\/\s*light|day\s*\/\s*night|theme\s*toggle|☀|☾|🌙|☀️)[\s\S]{0,200}?<\/(?:button|div|label|a)>/gi,
    ) ?? [];
  const classToggles =
    html.match(/class=["'][^"']*theme-toggle[^"']*["']/gi) ?? [];
  const count = Math.max(toggleNodes.length, classToggles.length);
  if (count > 1) {
    issues.push({
      code: "element_invented",
      detail: `Pinned theme-toggle but mock has ${count} theme controls — embed the shared element once`,
    });
  }
  return issues;
}

/** Copy imported loop elements into phase design/elements/ on implement. */
export function bindDesignElementsToPhase(opts: {
  projectRoot: string;
  loopId: string;
  phaseId: string;
}): DesignElementRef[] {
  const refs = readDesignLoopElements(opts.projectRoot, opts.loopId);
  if (!refs.length) return [];
  const phaseElRoot = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "design",
    "elements",
  );
  mkdirSync(phaseElRoot, { recursive: true });
  const bound: DesignElementRef[] = [];
  for (const ref of refs) {
    const srcDir = join(
      designLoopDir(opts.projectRoot, opts.loopId),
      "elements",
      ref.id,
      `v${ref.version}`,
    );
    if (!existsSync(srcDir)) continue;
    const dest = join(phaseElRoot, ref.id, `v${ref.version}`);
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      if (name === "src") continue;
      const full = join(srcDir, name);
      if (statSync(full).isFile()) copyFileSync(full, join(dest, name));
    }
    const srcTree = join(srcDir, "src");
    if (existsSync(srcTree)) {
      writeSrcTree(join(dest, "src"), readSrcTree(srcTree));
    }
    const base = `.slopcontrol/phases/${opts.phaseId}/design/elements/${ref.id}/v${ref.version}`;
    bound.push({
      ...ref,
      mockPath: `${base}/mock.html`,
      specPath: `${base}/SPEC.md`,
      codePath: ref.hasCode ? `${base}/src` : undefined,
    });
  }
  writeFileSync(
    join(phaseElRoot, "ELEMENTS.json"),
    `${JSON.stringify(bound, null, 2)}\n`,
  );
  return bound;
}

/** Detect element import intent from chat (theme-toggle from jamroast). */
export function detectElementImportFromText(opts: {
  text: string;
  targetRoot: string;
  dataDir?: string;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
}): DesignElementBundle | null {
  const t = opts.text ?? "";
  const idMatch =
    t.match(
      /\b(?:use|import|pin|adopt|pull)\b.{0,40}\b(theme-toggle|[\w-]+-toggle|[\w-]+-control)\b/i,
    ) ||
    t.match(/\b(theme-toggle)@?(\d+)?\b/i);
  const elementId = idMatch?.[1] ? slugElementId(idMatch[1]) : null;
  if (!elementId && !/\b(shared\s+element|design\s+element)\b/i.test(t)) {
    // theme language + from sibling still tries theme-toggle
    if (
      !/\b(theme\s*toggle|day\s*\/\s*night|dark\s*(and|&|\/)\s*light\s*button)\b/i.test(
        t,
      )
    ) {
      return null;
    }
  }
  const id = elementId || "theme-toggle";
  let origin: string | undefined;
  const fromMatch = t.match(
    /\bfrom\s+(jamroast|jamlight|jampress|burntjam|registry|[\w.-]+)/i,
  );
  if (fromMatch?.[1]) {
    const name = fromMatch[1].toLowerCase();
    origin = name === "registry" ? "registry" : `project:${name}`;
  }
  return resolveDesignElement({
    elementId: id,
    targetRoot: opts.targetRoot,
    dataDir: opts.dataDir,
    listProjects: opts.listProjects,
    origin,
  });
}

/** Convenience: extract from loop mock version then publish. */
export function extractAndPublishDesignElementFromLoop(opts: {
  projectRoot: string;
  loopId: string;
  version?: number;
  elementId?: string;
  kind?: DesignElementKind;
  label?: string;
  publishToRegistry?: boolean;
  dataDir?: string;
  sourceProjectId?: string;
  srcFiles?: Record<string, string>;
}): DesignElementMeta {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const version = opts.version ?? meta.currentVersion;
  const html =
    readDesignLoopMockHtml(opts.projectRoot, opts.loopId, version) ?? "";
  if (!html.trim()) {
    throw new Error(`No mock HTML for ${opts.loopId} v${version}`);
  }
  const extracted = extractDesignElementFromMock({
    html,
    elementId: opts.elementId,
    kind: opts.kind,
    label: opts.label,
    brief: meta.brief,
  });
  return publishDesignElement({
    projectRoot: opts.projectRoot,
    elementId: extracted.elementId,
    kind: extracted.kind,
    label: extracted.label,
    spec: extracted.spec,
    mockHtml: extracted.mockHtml,
    tokensCss: extracted.tokensCss,
    srcFiles: opts.srcFiles ?? extracted.srcFiles,
    states: extracted.states,
    a11y: extracted.a11y,
    mountHints: extracted.mountHints,
    themeRequirements: extracted.themeRequirements,
    publishToRegistry: opts.publishToRegistry,
    dataDir: opts.dataDir,
    sourceProjectId: opts.sourceProjectId ?? meta.projectId,
  });
}

/**
 * Prepare (or refresh) npm-package/ under an element version for registry publish.
 */
export function prepareDesignElementNpmPackage(opts: {
  projectRoot: string;
  elementId: string;
  version?: number;
  libraryRoot?: string;
}): {
  packageRoot: string;
  packageName: string;
  packageVersion: string;
  meta: DesignElementMeta;
} {
  const id = slugElementId(opts.elementId);
  const libraryRoot =
    opts.libraryRoot ?? projectElementsRoot(opts.projectRoot);
  const index = readElementIndex(libraryRoot);
  const entry = index.elements.find((e) => e.id === id);
  const version = opts.version ?? entry?.latestVersion;
  if (!version) {
    throw new Error(`Element not found in library: ${id}`);
  }
  const bundle = readDesignElementBundle(libraryRoot, id, version);
  if (!bundle) {
    throw new Error(`Element bundle missing: ${id}@${version}`);
  }
  const scaffold = scaffoldElementNpmPackage({
    outDir: join(bundle.rootPath, "npm-package"),
    elementId: id,
    version: bundle.meta.version,
    label: bundle.meta.label,
    srcFiles: bundle.srcFiles,
    description: bundle.meta.label,
  });
  return {
    packageRoot: scaffold.packageRoot,
    packageName: scaffold.packageName,
    packageVersion: scaffold.packageVersion,
    meta: bundle.meta,
  };
}

/** Persist npmPackage/npmVersion on ELEMENT.json + INDEX after a successful npm publish. */
export function recordDesignElementNpmPublish(opts: {
  projectRoot: string;
  elementId: string;
  version: number;
  npmPackage: string;
  npmVersion: string;
  libraryRoot?: string;
}): DesignElementMeta {
  const libraryRoot =
    opts.libraryRoot ?? projectElementsRoot(opts.projectRoot);
  const dir = elementVersionDir(libraryRoot, opts.elementId, opts.version);
  const metaPath = join(dir, "ELEMENT.json");
  if (!existsSync(metaPath)) {
    throw new Error(`ELEMENT.json missing for ${opts.elementId}@${opts.version}`);
  }
  const meta = DesignElementMetaSchema.parse({
    ...JSON.parse(readFileSync(metaPath, "utf-8")),
    npmPackage: opts.npmPackage || jamPackageNameForElement(opts.elementId),
    npmVersion: opts.npmVersion,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  upsertIndexEntry(libraryRoot, meta);
  return meta;
}
