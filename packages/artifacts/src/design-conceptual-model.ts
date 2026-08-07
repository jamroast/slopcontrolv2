/**
 * Design-loop conceptual model: dynamic scope frame + structured theme contract.
 * Persisted on META.scope and DESIGN_PACK (scope + theme); prompts call it
 * "CONCEPTUAL MODEL".
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  DesignLoopAcceptanceFeature,
  DesignLoopMeta,
} from "./design-loop.js";
import type { ContinueIntent } from "./continue-intent.js";

export const DesignScopeKindSchema = z.enum([
  "product",
  "shell",
  "screen",
  "component",
  "flow",
]);
export type DesignScopeKind = z.infer<typeof DesignScopeKindSchema>;

export const DesignScopeSourceSchema = z.enum([
  "start",
  "continue",
  "accept",
  "manual",
]);
export type DesignScopeSource = z.infer<typeof DesignScopeSourceSchema>;

export const DesignScopeSchema = z.object({
  kind: DesignScopeKindSchema,
  /** Operator-facing focus, e.g. "chat.composer", "invoice form", "menubar theme" */
  focus: z.string().min(1),
  /** Optional live paths / inventory anchors when known */
  focusPaths: z.array(z.string()).default([]),
  /** Frozen outside the focus — chrome, palette, nav, logo, … */
  preserve: z.array(z.string()).default([]),
  source: DesignScopeSourceSchema.default("start"),
});
export type DesignScope = z.infer<typeof DesignScopeSchema>;

export const ThemeContractSchema = z.object({
  mechanism: z.literal("data-theme"),
  defaultMode: z.enum(["dark", "light"]),
  modes: z.array(z.enum(["dark", "light"])).min(1),
  togglePresent: z.boolean(),
  darkTokensCss: z.string(),
  lightTokensCss: z.string(),
  requirements: z.array(z.string()),
});
export type ThemeContract = z.infer<typeof ThemeContractSchema>;

/** API/MCP summary of the conceptual model. */
export type ConceptualModelSummary = {
  kind: DesignScopeKind;
  focus: string;
  preserve: string[];
  focusPaths: string[];
  theme?: {
    mechanism: "data-theme";
    defaultMode: "dark" | "light";
    modes: Array<"dark" | "light">;
    togglePresent: boolean;
  };
  inScope: string[];
};

export const DEFAULT_THEME_REQUIREMENTS: string[] = [
  'Theme is driven by html[data-theme="dark"|"light"] (not an unused .light class alone).',
  "Semantic tokens (--background, --surface, --foreground, …) remap under [data-theme=\"light\"].",
  "Body/chrome consume those semantic vars — not hard-coded --color-dark-* that ignore the toggle.",
  "Toggle control sets data-theme (and storage key if present).",
];

export const PRODUCT_FALLBACK_FEATURES: DesignLoopAcceptanceFeature[] = [
  { id: "palette", label: "Palette — sibling tokens", accepted: false },
  { id: "logo", label: "Logo / mark", accepted: false },
  { id: "type", label: "Typography", accepted: false },
  {
    id: "applied_shell",
    label: "Applied frames — shell / dashboard chrome",
    accepted: false,
  },
];

export const THEME_MODES_FEATURE: DesignLoopAcceptanceFeature = {
  id: "theme_modes",
  label: "Theme modes — dark / light (data-theme)",
  accepted: false,
};

export function defaultProductScope(source: DesignScopeSource = "start"): DesignScope {
  return DesignScopeSchema.parse({
    kind: "product",
    focus: "site",
    focusPaths: [],
    preserve: [],
    source,
  });
}

/** Fallback feature seeds for a scope kind (before mock section merge). */
export function fallbackFeaturesForScope(
  scope: DesignScope,
  opts?: { includeThemeModes?: boolean },
): DesignLoopAcceptanceFeature[] {
  const theme =
    opts?.includeThemeModes === true
      ? [{ ...THEME_MODES_FEATURE }]
      : [];
  switch (scope.kind) {
    case "product":
      return [...PRODUCT_FALLBACK_FEATURES.map((f) => ({ ...f })), ...theme];
    case "shell": {
      const out: DesignLoopAcceptanceFeature[] = [
        {
          id: "applied_shell",
          label: "Applied frames — shell / dashboard chrome",
          accepted: false,
        },
        ...theme,
      ];
      if (/logo|mark/i.test(scope.focus)) {
        out.unshift({ id: "logo", label: "Logo / mark", accepted: false });
      }
      if (/palette|token|color/i.test(scope.focus)) {
        out.unshift({
          id: "palette",
          label: "Palette — sibling tokens",
          accepted: false,
        });
      }
      return out;
    }
    case "screen":
      return [
        {
          id: `screen_${slugFocus(scope.focus)}`,
          label: `Screen — ${scope.focus}`,
          accepted: false,
        },
        ...theme,
      ];
    case "component":
    case "flow":
      return [
        {
          id: `focus_${slugFocus(scope.focus)}`,
          label: `${scope.kind === "flow" ? "Flow" : "Component"} — ${scope.focus}`,
          accepted: false,
        },
      ];
    default:
      return [...PRODUCT_FALLBACK_FEATURES.map((f) => ({ ...f })), ...theme];
  }
}

function slugFocus(focus: string): string {
  return (
    focus
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "element"
  );
}

/**
 * Merge continue-intent targets into a scope patch (narrow when surgical).
 */
export function applyContinueIntentToScope(
  prior: DesignScope,
  intent: ContinueIntent,
  message: string,
): DesignScope {
  // Explicit structured designScope patch wins when present
  if (intent.designScope && (intent.designScope.kind || intent.designScope.focus)) {
    return DesignScopeSchema.parse({
      kind: intent.designScope.kind ?? prior.kind,
      focus: intent.designScope.focus ?? prior.focus,
      focusPaths: prior.focusPaths,
      preserve: intent.designScope.preserve ?? prior.preserve,
      source: "continue",
    });
  }

  void message;
  if (intent.scope === "full_revise") {
    return defaultProductScope("continue");
  }
  // Logo / icon / asset-only continues narrow to component focus so acceptance
  // ticks reset outside logo (V5-after-V2) and research stays delta-scoped.
  if (
    intent.scope === "assets_only" ||
    intent.scope === "logo_invent" ||
    intent.inventLogo ||
    (intent.wantsAssetEdit && intent.preserveChrome)
  ) {
    const focus = intent.targets.includes("palette")
      ? "palette"
      : intent.targets.includes("typography")
        ? "typography"
        : "logo";
    return DesignScopeSchema.parse({
      kind: "component",
      focus,
      focusPaths: [],
      preserve: ["chrome", "layout", "nav", "shell", "copy", "content", "palette"].filter(
        (p) => p !== focus,
      ),
      source: "continue",
    });
  }
  if (intent.targets.includes("chat") && intent.preserveChrome) {
    return DesignScopeSchema.parse({
      kind: "component",
      focus: "chat",
      focusPaths: [],
      preserve: ["chrome", "palette", "logo", "nav", "shell"],
      source: "continue",
    });
  }
  if (
    (intent.targets.includes("shell") || intent.targets.includes("nav")) &&
    intent.targets.length <= 2 &&
    !intent.targets.includes("landing")
  ) {
    return DesignScopeSchema.parse({
      kind: "shell",
      focus: intent.targets.includes("nav") ? "menubar" : "shell",
      focusPaths: [],
      preserve: ["logo", "content", "palette"].filter(
        (p) => !intent.targets.includes(p as "logo" | "palette"),
      ),
      source: "continue",
    });
  }
  return DesignScopeSchema.parse({ ...prior, source: "continue" });
}

export function withUpdatedScope(
  meta: DesignLoopMeta,
  scope: DesignScope,
): DesignLoopMeta {
  return {
    ...meta,
    scope,
    updatedAt: new Date().toISOString(),
  };
}

/** Extract a balanced `{…}` CSS block starting at `openBrace` index. */
function extractBalancedBlock(css: string, openBrace: number): string | null {
  if (css[openBrace] !== "{") return null;
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return css.slice(openBrace, i + 1);
    }
  }
  return null;
}

function findRuleBlock(css: string, selectorRe: RegExp): string | null {
  const m = selectorRe.exec(css);
  if (!m || m.index === undefined) return null;
  const open = css.indexOf("{", m.index);
  if (open < 0) return null;
  const body = extractBalancedBlock(css, open);
  if (!body) return null;
  const selector = css.slice(m.index, open).trim();
  return `${selector} ${body}`;
}

/** All style tag contents concatenated. */
export function collectStyleCssFromHtml(html: string): string {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
  return blocks.map((m) => m[1] ?? "").join("\n");
}

/**
 * Extract :root (dark/default) and [data-theme="light"] / .light token blocks.
 */
export function extractThemeTokenBlocks(html: string): {
  darkTokensCss: string;
  lightTokensCss: string;
  combinedTokensCss: string;
} {
  const css = collectStyleCssFromHtml(html);
  const dark =
    findRuleBlock(css, /:root\b(?![^\n{]*data-theme)/i) ||
    findRuleBlock(css, /:root\s*,\s*\.dark\b/i) ||
    "";
  const light =
    findRuleBlock(css, /\[data-theme\s*=\s*["']light["']\]/i) ||
    findRuleBlock(css, /:root\[data-theme\s*=\s*["']light["']\]/i) ||
    findRuleBlock(css, /(^|[,}\s])\.light\b/i) ||
    "";

  const darkNorm = dark.trim()
    ? dark.trim().endsWith("\n")
      ? dark.trim()
      : `${dark.trim()}\n`
    : "";
  const lightNorm = light.trim()
    ? light.trim().endsWith("\n")
      ? light.trim()
      : `${light.trim()}\n`
    : "";

  // Normalize light selector to canonical [data-theme="light"] when it was .light
  let lightOut = lightNorm;
  if (lightOut && /^\.light\b/.test(lightOut)) {
    lightOut = lightOut.replace(/^\.light\b/, '[data-theme="light"]');
  }

  const combined = [darkNorm, lightOut].filter(Boolean).join("\n");
  return {
    darkTokensCss: darkNorm || fallbackDarkRoot(),
    lightTokensCss: lightOut,
    combinedTokensCss: combined || fallbackDarkRoot(),
  };
}

function fallbackDarkRoot(): string {
  return `:root {
  /* seeded from design-loop mock — refine if needed */
  --color-bg: #0A0A0A;
  --color-text: #F5F0E8;
  --color-accent: #E8430A;
}
`;
}

export function detectThemeToggleInHtml(html: string): boolean {
  return /theme-toggle|data-theme-val|id=["']theme-(dark|light)|Switch to (dark|light) theme/i.test(
    html,
  );
}

export function extractThemeContractFromHtml(
  html: string,
  opts?: { request?: string; notes?: string },
): ThemeContract | null {
  const blob = `${html}\n${opts?.request ?? ""}\n${opts?.notes ?? ""}`;
  const { darkTokensCss, lightTokensCss } = extractThemeTokenBlocks(html);
  const togglePresent = detectThemeToggleInHtml(html);
  const mentionsDual =
    /\bdark\b/i.test(blob) && /\blight\b/i.test(blob);
  const hasLightBlock = Boolean(lightTokensCss.trim());
  const dataThemeInHtml = /data-theme\s*=/i.test(html);

  if (!hasLightBlock && !togglePresent && !(mentionsDual && dataThemeInHtml)) {
    // Soft mention only — still emit contract when toggle + dark/light words
    if (!(togglePresent && mentionsDual)) return null;
  }

  if (!hasLightBlock && !togglePresent && !mentionsDual) return null;

  const defaultMode: "dark" | "light" = /data-theme\s*=\s*["']light["']/i.test(
    html.slice(0, 500),
  )
    ? "light"
    : "dark";

  const modes: Array<"dark" | "light"> = hasLightBlock
    ? ["dark", "light"]
    : mentionsDual || togglePresent
      ? ["dark", "light"]
      : [defaultMode];

  return ThemeContractSchema.parse({
    mechanism: "data-theme",
    defaultMode,
    modes,
    togglePresent: togglePresent || mentionsDual,
    darkTokensCss,
    lightTokensCss:
      lightTokensCss ||
      (modes.includes("light")
        ? `[data-theme="light"] {\n  /* light ladder — implement from mock */\n}\n`
        : ""),
    requirements: [...DEFAULT_THEME_REQUIREMENTS],
  });
}

export function formatConceptualModelPromptBlock(opts: {
  scope: DesignScope;
  theme?: ThemeContract | null;
  inScope?: string[];
  mustNot?: string[];
  /** When true, instruct mock agent about focus-sized composition */
  forMock?: boolean;
}): string {
  const { scope, theme, inScope, mustNot, forMock } = opts;
  const lines: string[] = [
    "CONCEPTUAL MODEL (authoritative scope for this turn — do not expand past focus):",
    `- kind: ${scope.kind}`,
    `- focus: ${scope.focus}`,
    `- preserve (frozen): ${scope.preserve.length ? scope.preserve.join(", ") : "(none)"}`,
  ];
  if (scope.focusPaths.length) {
    lines.push(`- focusPaths: ${scope.focusPaths.join(", ")}`);
  }
  if (inScope?.length) {
    lines.push(`- inScope features: ${inScope.join(", ")}`);
  }
  if (mustNot?.length) {
    lines.push("- mustNot:");
    for (const m of mustNot.slice(0, 12)) lines.push(`  - ${m}`);
  }
  if (theme) {
    lines.push("");
    lines.push("### Theme contract");
    lines.push(`- mechanism: ${theme.mechanism}`);
    lines.push(`- defaultMode: ${theme.defaultMode}`);
    lines.push(`- modes: ${theme.modes.join(", ")}`);
    lines.push(`- togglePresent: ${theme.togglePresent}`);
    for (const r of theme.requirements) lines.push(`- REQ: ${r}`);
    if (theme.lightTokensCss.trim()) {
      lines.push("");
      lines.push("### light tokens (must ship in product CSS)");
      lines.push("```css");
      lines.push(theme.lightTokensCss.trim().slice(0, 2_000));
      lines.push("```");
    }
  }
  if (forMock) {
    lines.push("");
    if (scope.kind === "component" || scope.kind === "flow") {
      lines.push(
        "MOCK SCOPE: One composition around the focus only. Optional thin ghost chrome labeled \"context — out of scope\". Do not redesign marketing/landing/IA.",
      );
    } else if (scope.kind === "shell") {
      lines.push(
        "MOCK SCOPE: Menubar/shell + theme toggle; prove both dark and light via data-theme. Do not invent new product IA.",
      );
    } else if (scope.kind === "screen") {
      lines.push(
        `MOCK SCOPE: Focus on the ${scope.focus} screen; keep preserve list frozen.`,
      );
    }
    if (theme && theme.modes.includes("light")) {
      lines.push(
        'MOCK CSS: Include :root dark tokens AND a [data-theme="light"] block that remaps --background/--surface/--foreground (and related). Toggle must set documentElement data-theme.',
      );
    }
  }
  return lines.join("\n");
}

export function summarizeConceptualModel(opts: {
  scope?: DesignScope | null;
  theme?: ThemeContract | null;
  inScope?: string[];
}): ConceptualModelSummary {
  const scope = opts.scope ?? defaultProductScope();
  return {
    kind: scope.kind,
    focus: scope.focus,
    preserve: scope.preserve,
    focusPaths: scope.focusPaths,
    theme: opts.theme
      ? {
          mechanism: opts.theme.mechanism,
          defaultMode: opts.theme.defaultMode,
          modes: opts.theme.modes,
          togglePresent: opts.theme.togglePresent,
        }
      : undefined,
    inScope: opts.inScope ?? [],
  };
}

/** Build API/MCP conceptualModel summary from loop META + pack + optional HTML. */
export function conceptualModelFromLoop(opts: {
  meta: DesignLoopMeta | null | undefined;
  pack?: {
    theme?: ThemeContract | null;
    inScope?: string[];
    scope?: DesignScope | null;
  } | null;
  html?: string | null;
  acceptanceInScope?: string[];
}): ConceptualModelSummary {
  const scope =
    opts.pack?.scope ??
    getDesignLoopScope(opts.meta);
  const theme =
    opts.pack?.theme ??
    (opts.html?.trim()
      ? extractThemeContractFromHtml(opts.html)
      : null);
  const inScope =
    opts.acceptanceInScope ??
    opts.pack?.inScope ??
    [];
  return summarizeConceptualModel({ scope, theme, inScope });
}

export type DesignLoopMetaWithScope = DesignLoopMeta & {
  scope?: DesignScope;
};

export function getDesignLoopScope(
  meta: DesignLoopMeta | null | undefined,
): DesignScope {
  const raw = (meta as DesignLoopMetaWithScope | null)?.scope;
  if (!raw) return defaultProductScope();
  try {
    return DesignScopeSchema.parse(raw);
  } catch {
    return defaultProductScope();
  }
}

/**
 * Lightweight theme contract check against product CSS under projectRoot.
 * Returns issues (empty = ok). Prefer warn posture at call sites.
 */
export function checkThemeContractInProject(opts: {
  projectRoot: string;
  theme: ThemeContract;
}): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const cssFiles = collectProjectCssSnippets(opts.projectRoot, 40);
  const blob = cssFiles.join("\n");
  if (!blob.trim()) {
    return { ok: false, issues: ["No CSS files found to check theme contract"] };
  }
  if (!/\[data-theme\s*=\s*["']light["']\]/i.test(blob) && !/\.light\b/.test(blob)) {
    issues.push(
      'Missing [data-theme="light"] (or .light) token remaps in product CSS',
    );
  }
  if (
    /\[data-theme\s*=\s*["']light["']\]/i.test(blob) &&
    !/--background|--surface|--foreground/i.test(blob)
  ) {
    issues.push(
      "Light theme block present but semantic tokens (--background/--surface/--foreground) not found nearby",
    );
  }
  // Hard-coded body on dark-only vars without data-theme body rule
  if (
    /body\s*\{[^}]*--color-dark-base/i.test(blob) &&
    !/:root\[data-theme\s*=\s*["']light["']\]\s*body|\[data-theme\s*=\s*["']light["']\][^{]*body/i.test(
      blob,
    )
  ) {
    issues.push(
      "body uses --color-dark-* without a [data-theme=light] body override — toggle may appear to do nothing",
    );
  }
  return { ok: issues.length === 0, issues };
}

function collectProjectCssSnippets(
  projectRoot: string,
  maxFiles: number,
): string[] {
  const out: string[] = [];
  const roots = [
    join(projectRoot, "src"),
    join(projectRoot, "app"),
    join(projectRoot, "public"),
    join(projectRoot, "styles"),
  ];
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > 5 || !existsSync(dir)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) break;
      if (name.startsWith(".") || name === "node_modules") continue;
      const abs = join(dir, name);
      try {
        if (name.endsWith(".css")) {
          out.push(readFileSync(abs, "utf-8").slice(0, 80_000));
        } else if (!name.includes(".")) {
          walk(abs, depth + 1);
        }
      } catch {
        /* ignore */
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Build mustNot extras from scope preserve list. */
export function scopePreserveMustNots(
  scope: DesignScope,
  opts?: {
    /**
     * When applied_shell is in scope, omit these preserve keys so mock chrome
     * layout (menubar width, nav slots) is not frozen as PRESERVE.
     */
    omitPreserveKeys?: string[];
  },
): string[] {
  if (scope.kind === "product" && !scope.preserve.length) return [];
  const omit = new Set(
    (opts?.omitPreserveKeys ?? []).map((k) => k.toLowerCase()),
  );
  const out: string[] = [];
  if (scope.kind === "component" || scope.kind === "flow") {
    out.push(
      `OUT OF SCOPE — do not expand beyond focus "${scope.focus}" into full site shell/marketing.`,
    );
  }
  for (const p of scope.preserve) {
    if (omit.has(p.toLowerCase())) continue;
    out.push(`PRESERVE — do not change ${p} unless the operator explicitly asks.`);
  }
  return out;
}

export function packHasThemeModes(pack: {
  theme?: ThemeContract | null;
  inScope?: string[];
  shell?: string[];
} | null | undefined): boolean {
  // Theme work is in scope only when the accept checklist / delta says so.
  // Inherited dual-theme mock HTML or shell notes must not widen a logo-only pass.
  return Boolean(pack?.inScope?.includes("theme_modes"));
}
