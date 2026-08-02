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
  /** Explicit must-nots for research/develop. */
  mustNot: string[];
  /** Path to full mock HTML (loop or phase). */
  mockPath: string;
  /** Dynamic conceptual-model scope frame. */
  scope?: DesignScope;
  /** Structured dark/light contract when dual modes / toggle present. */
  theme?: ThemeContract;
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

function extractShellNotes(html: string, request: string, notes: string): string[] {
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
  if (/\bmenubar\b|\btop\s*bar\b|\bnav\b/.test(blob)) {
    notesOut.push("Respect menubar / top-nav shell patterns from the mock.");
  }
  if (/\bdashboard\b/.test(blob)) {
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

function buildMustNot(
  acceptance: DesignLoopAcceptance,
  logos: DesignPack["logos"],
  scope?: DesignScope | null,
): string[] {
  const out: string[] = [
    "Do not invent a competing logo/mark metaphor when logos[] lists accepted assets.",
    "Do not treat public/brand/*-reuse.svg tile stubs as the accepted mark.",
  ];
  if (scope) out.push(...scopePreserveMustNots(scope));
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
  const inScope = opts.acceptance.features
    .filter((f) => f.accepted)
    .map((f) => f.id);
  // Ensure theme_modes is listed when theme contract exists and was accepted
  if (
    theme &&
    opts.acceptance.features.some(
      (f) => f.id === "theme_modes" && f.accepted,
    ) &&
    !inScope.includes("theme_modes")
  ) {
    inScope.push("theme_modes");
  }
  const now = new Date().toISOString();
  const name =
    meta.brief.trim().slice(0, 80) ||
    `design-loop-${opts.loopId.slice(0, 8)}`;

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
    mustNot: buildMustNot(opts.acceptance, logos, scope),
    mockPath: `.slopcontrol/design-loops/${opts.loopId}/v${opts.version}/mock.html`,
    scope: { ...scope, source: "accept" },
    theme,
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
  const lines: string[] = [
    `Design pack / conceptual model (authoritative — cite this; mock.html is visual proof):`,
    `- name: ${pack.name}`,
    `- pack version: ${pack.version} (from design-loop ${pack.loopId} mock v${pack.sourceMockVersion})`,
    `- mock: \`${pack.mockPath}\``,
    `- inScope: ${pack.inScope.length ? pack.inScope.join(", ") : "(none)"}`,
    "",
  ];
  if (pack.scope) {
    lines.push(
      formatConceptualModelPromptBlock({
        scope: pack.scope,
        theme: pack.theme,
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
  if (pack.theme?.lightTokensCss?.trim()) {
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
  if (pack.typography.length) {
    lines.push("### typography");
    for (const t of pack.typography) lines.push(`- ${t}`);
    lines.push("");
  }
  if (pack.shell.length) {
    lines.push("### shell");
    for (const s of pack.shell) lines.push(`- ${s}`);
    lines.push("");
  }
  if (pack.contentPillars.length) {
    lines.push("### contentPillars");
    for (const c of pack.contentPillars) lines.push(`- ${c}`);
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
