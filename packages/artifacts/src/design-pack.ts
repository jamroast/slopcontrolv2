import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  designLoopDir,
  extractFeaturesFromMockHtml,
  listDesignLoopAssets,
  readDesignLoopAcceptance,
  readDesignLoopMeta,
  readDesignLoopMockHtml,
  readDesignLoopNotes,
  readDesignLoopRequest,
  readDesignLoopTranscript,
  resolveDesignImplementInScope,
  type DesignLoopAcceptance,
  type DesignLoopMeta,
} from "./design-loop.js";
import {
  extractThemeContractFromHtml,
  extractThemeTokenBlocks,
  formatConceptualModelPromptBlock,
  getDesignLoopScope,
  scopePreserveMustNots,
  type DesignScope,
  type ThemeContract,
} from "./design-conceptual-model.js";
import {
  getDesignLoopElements,
  type DesignElementRef,
} from "./design-element.js";
import {
  getDesignLoopSelections,
  type DesignLoopSelection,
} from "./design-loop-selections.js";

/** Operator-pinned selection carried into the pack (logo, palette, …). */
export type DesignPackSelection = DesignLoopSelection & {
  /** Loop-relative (or phase-relative after bind) asset path. */
  path?: string;
};

const SLOP_DIR = ".slopcontrol";

/** Durable theme/brand contract compiled on design-loop accept (= conceptual model). */
export type DesignPack = {
  name: string;
  version: number;
  loopId: string;
  projectId: string;
  sourceMockVersion: number;
  /** Canonical CSS from accepted mock (:root + light overrides). */
  tokens: string;
  /** Loop-relative or phase-relative logo/asset paths. */
  logos: Array<{ name: string; path: string }>;
  /** Font / type cues extracted from mock CSS when present. */
  typography: string[];
  /** Short shell/chrome notes (dark/light, clerk, nav). */
  shell: string[];
  /** Content / positioning pillars from request + notes + sections. */
  contentPillars: string[];
  /** Accepted feature ids. */
  inScope: string[];
  /**
   * Feature ids shipped on a prior implement — contextual must-not redo unless
   * also listed in inScope for this accept.
   */
  alreadyApplied?: string[];
  /** Explicit must-nots for research/develop. */
  mustNot: string[];
  /** Path to full mock HTML (loop or phase). */
  mockPath: string;
  /** Dynamic conceptual-model scope frame. */
  scope?: DesignScope;
  /** Structured dark/light contract when dual modes / toggle present. */
  theme?: ThemeContract;
  /** Pinned shared design elements (controls/patterns) on accept. */
  elements?: DesignElementRef[];
  /**
   * Operator-pinned selections (logo, palette, …) at accept time. The pinned
   * logo is authoritative — implement must wire THIS asset as the product logo.
   */
  selections?: DesignPackSelection[];
  createdAt: string;
  updatedAt: string;
};

export function designLoopPackPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "DESIGN_PACK.json");
}

export function phaseDesignPackPath(
  projectRoot: string,
  phaseId: string,
): string {
  return join(
    projectRoot,
    SLOP_DIR,
    "phases",
    phaseId,
    "design",
    "DESIGN_PACK.json",
  );
}

function extractTypographyCues(html: string): string[] {
  const cues: string[] = [];
  const fontFamily = [
    ...html.matchAll(/--(?:font|type)[-\w]*\s*:\s*([^;}+]+)/gi),
  ];
  for (const m of fontFamily) {
    const v = (m[1] ?? "").trim();
    if (v && !cues.includes(v)) cues.push(v);
  }
  const ff = [...html.matchAll(/font-family\s*:\s*([^;}+]+)/gi)];
  for (const m of ff.slice(0, 4)) {
    const v = (m[1] ?? "").trim();
    if (v && v.length < 120 && !cues.includes(v)) cues.push(v);
  }
  return cues.slice(0, 8);
}

/**
 * True when the mock shows a content-aligned menubar (inner bar at
 * `--content-max`, not full-bleed flex children on the sticky header).
 */
export function mockHasContentAlignedMenubar(html: string): boolean {
  const h = html ?? "";
  if (/menubar__inner/i.test(h)) return true;
  if (/landing-header-inner/i.test(h) && /--content-max/i.test(h)) return true;
  // *-header-inner / menubar inner with content-max
  if (
    /(?:header|menubar)(?:__|-)?inner\b[\s\S]{0,400}max-width\s*:\s*var\(\s*--content-max/i.test(
      h,
    )
  ) {
    return true;
  }
  // menubar CSS block with max-width + content-max
  if (
    /\.menubar\b[\s\S]{0,800}max-width\s*:\s*var\(\s*--content-max/i.test(h) ||
    /\.menubar__[a-z0-9_-]*\b[\s\S]{0,400}max-width\s*:\s*var\(\s*--content-max/i.test(
      h,
    )
  ) {
    return true;
  }
  // Centered menubar wrapping an inner container constrained to content-max
  if (
    /\bmenubar\b/i.test(h) &&
    /--content-max/i.test(h) &&
    /justify-content\s*:\s*center/i.test(h) &&
    /max-width\s*:\s*var\(\s*--content-max/i.test(h)
  ) {
    return true;
  }
  return false;
}

/**
 * True when the mock shows a full-viewport dashboard chrome frame
 * (edge-to-edge bar / DashboardShell-style fill), distinct from landing
 * content-max marketing chrome.
 */
export function mockHasDashboardFullBleedShell(html: string): boolean {
  const h = html ?? "";
  if (/dash-header\b/i.test(h) && /full[- ]?(?:viewport[- ]?)?width|FULL WIDTH/i.test(h)) {
    return true;
  }
  if (
    /\bdashboard\b/i.test(h) &&
    /(?:full[- ]?screen|full[- ]?viewport|100vh|100dvh|min-height\s*:\s*calc\s*\(\s*100vh)/i.test(
      h,
    )
  ) {
    return true;
  }
  if (/DashboardShell|dashboard-shell/i.test(h)) return true;
  return false;
}

/** Concrete + heuristic shell notes for DESIGN_PACK.shell. */
export function extractShellNotes(
  html: string,
  request: string,
  notes: string,
): string[] {
  const blob = `${html}\n${request}\n${notes}`.toLowerCase();
  const notesOut: string[] = [];
  if (/\bdark\b/.test(blob) && /\blight\b/.test(blob)) {
    notesOut.push("Support dark and light mode (theme toggle).");
  } else if (/\bdark\s*mode\b/.test(blob)) {
    notesOut.push("Dark mode theming.");
  }
  if (/\bclerk\b/.test(blob)) {
    notesOut.push("Include Clerk auth chrome on dashboard / signed-in shell.");
  }
  if (/\btaste\s*room\b/.test(blob)) {
    notesOut.push("Taste Room concept in applied frames / content.");
  }
  const contentAligned = mockHasContentAlignedMenubar(html);
  const dashFullBleed = mockHasDashboardFullBleedShell(html);
  const dualChrome =
    contentAligned &&
    dashFullBleed &&
    (/\blanding\b/.test(blob) || /landing-header/i.test(html));

  if (dualChrome) {
    notesOut.push(
      "Landing menubar: center an inner bar at max-width: var(--content-max) matching page content (marketing chrome).",
    );
    notesOut.push(
      "Dashboard menubar: full-viewport-width bar (edge-to-edge background); inner slots may still align to --content-max — do not constrain the bar itself to content-max.",
    );
    notesOut.push(
      "Dashboard shell: fill the viewport below the bar (min-height: calc(100vh - var(--bar-h))) with sidebar + main like jamroast DashboardShell — not a content-max card stack in a short mock section.",
    );
    notesOut.push(
      "Menubar slots: logo + primary nav left; auth / theme (and optional view switcher) right within the inner bar.",
    );
  } else if (contentAligned) {
    notesOut.push(
      "Menubar: center an inner bar at max-width: var(--content-max) matching page content (not full-bleed flex children).",
    );
    notesOut.push(
      "Menubar slots: logo + primary nav left; auth / theme (and optional view switcher) right within the inner bar.",
    );
  } else if (/\bmenubar\b|\btop\s*bar\b|\bnav\b/.test(blob)) {
    notesOut.push("Respect menubar / top-nav shell patterns from the mock.");
  }
  if (dashFullBleed && !dualChrome) {
    notesOut.push(
      "Dashboard: full-viewport shell (edge-to-edge chrome / min-height calc(100vh - var(--bar-h))).",
    );
  } else if (/\bdashboard\b/.test(blob) && !dualChrome) {
    notesOut.push("Dashboard / portal applied frames are part of the visual contract.");
  }
  return notesOut.slice(0, 10);
}

function extractContentPillars(opts: {
  brief: string;
  request: string;
  notes: string;
  html: string;
}): string[] {
  const pillars: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (!t || t.length < 8) return;
    if (pillars.some((p) => p.toLowerCase() === t.toLowerCase())) return;
    pillars.push(t.slice(0, 200));
  };

  const blob = `${opts.request}\n${opts.notes}\n${opts.brief}`;
  // Operator framing lines (agency vs platform, product suites, etc.)
  for (const line of blob.split(/\n+/)) {
    const l = line.trim();
    if (
      /agency|platform|taste\s*room|product\s*development|jamroast|jampress|jamlight|slopcontrol|content/i.test(
        l,
      ) &&
      l.length < 220
    ) {
      push(l.replace(/^#+\s*/, "").replace(/^[-*]\s*/, ""));
    }
  }

  for (const f of extractFeaturesFromMockHtml(opts.html)) {
    push(`Mock section: ${f.label}`);
  }

  // Headline-ish text from mock
  const h1 = opts.html.match(/<h1[^>]*>([^<]{8,120})<\/h1>/i);
  if (h1?.[1]) push(`Headline: ${h1[1].replace(/\s+/g, " ").trim()}`);

  return pillars.slice(0, 16);
}

/**
 * Preserve must-nots from conceptual scope. When applied_shell is in scope,
 * mock chrome layout is authoritative — omit PRESERVE for shell/nav/chrome.
 */
function buildMustNot(
  acceptance: DesignLoopAcceptance,
  logos: DesignPack["logos"],
  scope?: DesignScope | null,
  inScope?: string[],
): string[] {
  const out: string[] = [
    "Do not invent a competing logo/mark metaphor when logos[] lists accepted assets.",
    "Do not treat public/brand/*-reuse.svg tile stubs as the accepted mark.",
  ];
  const appliedShellInScope =
    (inScope ?? []).includes("applied_shell") ||
    acceptance.features.some((f) => f.id === "applied_shell" && f.accepted);
  if (scope) {
    out.push(
      ...scopePreserveMustNots(scope, {
        // applied_shell means implement mock chrome; do not freeze nav/shell.
        omitPreserveKeys: appliedShellInScope
          ? ["shell", "nav", "chrome"]
          : [],
      }),
    );
  }
  const unticked = acceptance.features.filter((f) => !f.accepted);
  for (const f of unticked) {
    out.push(`OUT OF SCOPE — do not expand into ${f.id}: ${f.label}`);
  }
  if (logos.length) {
    out.push(
      "Do not replace accepted raster/SVG assets with a new monogram (e.g. bottle-cap initials) unless the operator explicitly rejects the pack logos.",
    );
  }
  return out.slice(0, 24);
}

/**
 * Compile DESIGN_PACK.json from an accepted (or about-to-accept) loop version.
 */
export function compileDesignPackFromAccept(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  acceptance: DesignLoopAcceptance;
  meta?: DesignLoopMeta | null;
  /** Override mock HTML (defaults to reading vN/mock.html). */
  html?: string;
}): DesignPack {
  const meta =
    opts.meta ?? readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const html =
    opts.html?.trim() ||
    readDesignLoopMockHtml(opts.projectRoot, opts.loopId, opts.version) ||
    "";
  if (!html.trim()) {
    throw new Error(
      `Cannot compile design pack — mock missing for ${opts.loopId} v${opts.version}`,
    );
  }
  const notes =
    readDesignLoopNotes(opts.projectRoot, opts.loopId, opts.version) ?? "";
  const request =
    readDesignLoopRequest(opts.projectRoot, opts.loopId, opts.version) ??
    meta.brief;
  // Prefer recent transcript cues for content pillars (last ~4k)
  const transcript = readDesignLoopTranscript(opts.projectRoot, opts.loopId);
  const transcriptTail = transcript.slice(-4_000);

  const tokenBlocks = extractThemeTokenBlocks(html);
  const tokens = tokenBlocks.combinedTokensCss;
  const theme =
    extractThemeContractFromHtml(html, {
      request,
      notes: `${notes}\n${transcriptTail}`,
    }) ?? undefined;
  const scope = getDesignLoopScope(meta);
  const assets = listDesignLoopAssets(
    opts.projectRoot,
    meta.projectId,
    opts.loopId,
  );
  const logos = assets.map((a) => ({
    name: a.name,
    path: `.slopcontrol/design-loops/${opts.loopId}/assets/${a.name}`,
  }));
  const acceptedIds = opts.acceptance.features
    .filter((f) => f.accepted)
    .map((f) => f.id);
  const { inScope, alreadyApplied } = resolveDesignImplementInScope({
    acceptedFeatureIds: acceptedIds,
    lastImplementedFeatureIds: meta.lastImplementedFeatureIds,
  });
  const now = new Date().toISOString();
  const name =
    meta.brief.trim().slice(0, 80) ||
    `design-loop-${opts.loopId.slice(0, 8)}`;

  const elements = getDesignLoopElements(meta);

  const selections = getDesignLoopSelections(meta).map((s) => ({
    ...s,
    path: s.asset
      ? `.slopcontrol/design-loops/${opts.loopId}/assets/${s.asset}`
      : undefined,
  }));

  const alreadyAppliedMustNots = alreadyApplied
    .filter((id) => !inScope.includes(id))
    .map(
      (id) =>
        `ALREADY APPLIED — do not re-implement ${id} (shipped on a prior design implement); only change it if explicitly inScope`,
    );

  return {
    name,
    version: 1,
    loopId: opts.loopId,
    projectId: meta.projectId,
    sourceMockVersion: opts.version,
    tokens,
    logos,
    typography: extractTypographyCues(html),
    shell: extractShellNotes(html, request, `${notes}\n${transcriptTail}`),
    contentPillars: extractContentPillars({
      brief: meta.brief,
      request: `${request}\n${transcriptTail}`,
      notes,
      html,
    }),
    inScope,
    alreadyApplied: alreadyApplied.length ? alreadyApplied : undefined,
    mustNot: [
      ...buildMustNot(opts.acceptance, logos, scope, inScope),
      ...alreadyAppliedMustNots,
      ...elements.map(
        (e) =>
          `Do not invent a competing control for shared element ${e.id}@${e.version} — mount the pinned element`,
      ),
    ].slice(0, 32),
    mockPath: `.slopcontrol/design-loops/${opts.loopId}/v${opts.version}/mock.html`,
    scope: { ...scope, source: "accept" },
    // Theme contract only authoritative when theme_modes is in this implement delta.
    theme: inScope.includes("theme_modes") ? theme : undefined,
    elements: elements.length ? elements : undefined,
    selections: selections.length ? selections : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function writeDesignLoopPack(
  projectRoot: string,
  loopId: string,
  pack: DesignPack,
): string {
  ensureDir(designLoopDir(projectRoot, loopId));
  const path = designLoopPackPath(projectRoot, loopId);
  const prior = readDesignLoopPack(projectRoot, loopId);
  const next: DesignPack = {
    ...pack,
    version: (prior?.version ?? 0) + 1,
    createdAt: prior?.createdAt ?? pack.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return path;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readDesignLoopPack(
  projectRoot: string,
  loopId: string,
): DesignPack | null {
  const path = designLoopPackPath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DesignPack;
  } catch {
    return null;
  }
}

export function readPhaseDesignPack(
  projectRoot: string,
  phaseId: string,
): DesignPack | null {
  const path = phaseDesignPackPath(projectRoot, phaseId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DesignPack;
  } catch {
    return null;
  }
}

/** Copy loop DESIGN_PACK.json into phase design/; rewrite logo paths to phase assets. */
export function copyDesignPackToPhase(opts: {
  projectRoot: string;
  loopId: string;
  phaseId: string;
}): DesignPack | null {
  const pack = readDesignLoopPack(opts.projectRoot, opts.loopId);
  if (!pack) return null;
  const designDir = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "design",
  );
  ensureDir(designDir);
  const phasePack: DesignPack = {
    ...pack,
    logos: pack.logos.map((l) => ({
      name: l.name,
      path: `.slopcontrol/phases/${opts.phaseId}/design/assets/${l.name}`,
    })),
    selections: pack.selections?.map((s) => ({
      ...s,
      path: s.asset
        ? `.slopcontrol/phases/${opts.phaseId}/design/assets/${s.asset}`
        : s.path,
    })),
    mockPath: `.slopcontrol/phases/${opts.phaseId}/design/mock.html`,
    updatedAt: new Date().toISOString(),
  };
  // Ensure assets exist under phase (bind usually copies; fill gaps)
  const loopAssets = join(designLoopDir(opts.projectRoot, opts.loopId), "assets");
  const phaseAssets = join(designDir, "assets");
  if (existsSync(loopAssets)) {
    ensureDir(phaseAssets);
    for (const name of readdirSync(loopAssets)) {
      if (name.startsWith(".")) continue;
      const dest = join(phaseAssets, name);
      if (!existsSync(dest)) {
        try {
          copyFileSync(join(loopAssets, name), dest);
        } catch {
          /* ignore */
        }
      }
    }
  }
  writeFileSync(
    phaseDesignPackPath(opts.projectRoot, opts.phaseId),
    `${JSON.stringify(phasePack, null, 2)}\n`,
    "utf-8",
  );
  return phasePack;
}

/** Prompt block for research / draft / develop (conceptual model + pack). */
export function formatDesignPackPromptBlock(
  pack: DesignPack | null | undefined,
): string {
  if (!pack) return "";
  const themeInScope = pack.inScope.includes("theme_modes");
  const lines: string[] = [
    `Design pack / conceptual model (authoritative — cite this; mock.html is visual proof):`,
    `- name: ${pack.name}`,
    `- pack version: ${pack.version} (from design-loop ${pack.loopId} mock v${pack.sourceMockVersion})`,
    `- mock: \`${pack.mockPath}\``,
    `- inScope (this phase only): ${pack.inScope.length ? pack.inScope.join(", ") : "(none)"}`,
  ];
  if (pack.alreadyApplied?.length) {
    lines.push(
      `- alreadyApplied (prior implement — do not redo unless also inScope): ${pack.alreadyApplied.join(", ")}`,
    );
  }
  lines.push("");
  if (pack.scope) {
    lines.push(
      formatConceptualModelPromptBlock({
        scope: pack.scope,
        theme: themeInScope ? pack.theme : undefined,
        inScope: pack.inScope,
        mustNot: pack.mustNot,
      }),
    );
    lines.push("");
  }
  lines.push(
    "### tokens",
    "```css",
    (pack.tokens ?? "").trim().slice(0, 4_000) || "/* none */",
    "```",
    "",
  );
  if (themeInScope && pack.theme?.lightTokensCss?.trim()) {
    lines.push(
      "### theme.lightTokensCss (must implement under html[data-theme=light])",
      "```css",
      pack.theme.lightTokensCss.trim().slice(0, 2_500),
      "```",
      "",
    );
    lines.push("### theme.requirements");
    for (const r of pack.theme.requirements) lines.push(`- ${r}`);
    lines.push("");
  }
  if (pack.logos.length) {
    lines.push("### logos (mount these — do not invent a competing mark)");
    for (const l of pack.logos) lines.push(`- ${l.name}: \`${l.path}\``);
    lines.push("");
  }
  const pinnedLogo = pack.selections?.find(
    (s) => s.slot === "logo" && s.asset,
  );
  if (pinnedLogo?.asset) {
    lines.push(
      "### pinned logo (OPERATOR-SELECTED — authoritative)",
      `- ${pinnedLogo.label ?? pinnedLogo.asset}: \`${pinnedLogo.path ?? pinnedLogo.asset}\``,
      `- Copy THIS exact file into the product's static brand dir (e.g. \`public/brand/${pinnedLogo.asset}\`) and wire it as THE product logo — menubar \`logoSrc\`, favicon/app icons. Do NOT substitute older brand files, other logo variants from the logos list, or tile+circle fallbacks. Automated Checks must grep the shell for the pinned filename.`,
      "",
    );
  }
  const otherSelections = (pack.selections ?? []).filter(
    (s) => s !== pinnedLogo,
  );
  if (otherSelections.length) {
    lines.push("### pinned selections (operator-pinned — preserve)");
    for (const s of otherSelections) {
      lines.push(
        `- ${s.slot}: ${s.label ?? s.conceptId}${s.path ? ` (\`${s.path}\`)` : ""}`,
      );
    }
    lines.push("");
  }
  if (pack.typography.length) {
    lines.push("### typography");
    for (const t of pack.typography) lines.push(`- ${t}`);
    lines.push("");
  }
  if (pack.shell.length) {
    lines.push("### shell");
    for (const s of pack.shell) lines.push(`- ${s}`);
    if (
      pack.inScope.includes("applied_shell") &&
      pack.shell.some((s) => /content-max|menubar__inner|inner bar/i.test(s))
    ) {
      if (pack.shell.some((s) => /Dashboard shell: fill the viewport|full-viewport-width bar/i.test(s))) {
        lines.push(
          "CRITICAL: applied_shell has dual chrome — landing menubar is content-max; dashboard bar is full-viewport-width with a viewport-filling shell (DashboardShell pattern). File Changes must implement both variants. Automated Checks: `--content-max` on landing/menubar path + Menubar/JampressMenubar mount in playground App **or** product shell (portal/marketing/layout).",
        );
      } else {
        lines.push(
          "CRITICAL: applied_shell includes content-aligned menubar — File Changes must update Menubar layout (inner `--content-max` wrapper + left/right slots), not only add props. Automated Checks must prove `--content-max` on the menubar inner bar and Menubar/JampressMenubar mount in playground App **or** product layout shell.",
        );
      }
    }
    lines.push("");
  }
  if (pack.contentPillars.length) {
    lines.push("### contentPillars");
    for (const c of pack.contentPillars) lines.push(`- ${c}`);
    lines.push("");
  }
  if (pack.elements?.length) {
    lines.push(
      "### elements (CRITICAL — mount these shared controls; prefer element src/ TS/JS when hasCode; prefer pnpm add when npmPackage set — never npm link)",
    );
    for (const e of pack.elements) {
      const npm =
        e.npmPackage != null
          ? ` npmPackage=${e.npmPackage}${e.npmVersion ? `@${e.npmVersion}` : ""}`
          : "";
      lines.push(
        `- ${e.id}@${e.version} (${e.kind ?? "control"})${e.hasCode ? " [hasCode]" : ""}${npm} mount: ${(e.mountHints ?? []).join(", ") || "host"}`,
      );
      if (e.mockPath) lines.push(`  mock: \`${e.mockPath}\``);
      if (e.specPath) lines.push(`  spec: \`${e.specPath}\``);
      if (e.codePath) lines.push(`  code: \`${e.codePath}\``);
      if (e.npmPackage) {
        lines.push(
          `  install: npm_registry_ensure_rc → pnpm add ${e.npmPackage}@${e.npmVersion ?? "latest"}`,
        );
      }
    }
    lines.push("");
  }
  if (pack.mustNot.length) {
    lines.push("### mustNot");
    for (const m of pack.mustNot) lines.push(`- ${m}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Accept-time helper: compile + write loop DESIGN_PACK.json.
 * Call after acceptance is persisted.
 */
export function compileAndWriteDesignPackOnAccept(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  acceptance?: DesignLoopAcceptance | null;
}): DesignPack {
  const acceptance =
    opts.acceptance ?? readDesignLoopAcceptance(opts.projectRoot, opts.loopId);
  if (!acceptance?.features?.length) {
    throw new Error("Cannot compile design pack without acceptance features");
  }
  const pack = compileDesignPackFromAccept({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    version: opts.version,
    acceptance,
  });
  writeDesignLoopPack(opts.projectRoot, opts.loopId, pack);
  return readDesignLoopPack(opts.projectRoot, opts.loopId) ?? pack;
}
