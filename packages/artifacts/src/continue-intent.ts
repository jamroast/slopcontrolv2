/**
 * Structured intent for design-loop continues.
 *
 * Primary path: LLM JSON (`classifyContinueIntentViaLlm`) — sole authority on
 * success. Regex (`fallbackContinueIntentFromText`) is catch / offline only.
 * Drift gating consumes these explicit targets/allow-flags.
 */

import { z } from "zod";

export const ContinueIntentScopeSchema = z.enum([
  "assets_only",
  "nav_align",
  "logo_invent",
  "adopt_theme",
  "sections",
  "full_revise",
]);
export type ContinueIntentScope = z.infer<typeof ContinueIntentScopeSchema>;

export const ContinueIntentTargetSchema = z.enum([
  "hero",
  "copy",
  "nav",
  "logo",
  "palette",
  "tokens",
  "typography",
  "shell",
  "layout",
  "tasting-room",
  "landing",
  "dashboard",
  "chat",
  "settings",
  "lockups",
]);
export type ContinueIntentTarget = z.infer<typeof ContinueIntentTargetSchema>;

/**
 * Design facets a fresh loop can inherit. The operator's intent declares which
 * facets are being REPLACED; every facet not listed inherits from the
 * project's current design (prior loop tokens/mock + pinned brand assets).
 */
export const DesignFacetSchema = z.enum(["theme", "logo", "graphics", "layout"]);
export type DesignFacet = z.infer<typeof DesignFacetSchema>;

export const ALL_DESIGN_FACETS: DesignFacet[] = [
  "theme",
  "logo",
  "graphics",
  "layout",
];

/** Optional conceptual-model scope patch from continue classification. */
export const DesignScopePatchSchema = z
  .object({
    kind: z.enum(["product", "shell", "screen", "component", "flow"]).optional(),
    focus: z.string().min(1).optional(),
    preserve: z.array(z.string()).optional(),
  })
  .optional();
export type DesignScopePatch = z.infer<typeof DesignScopePatchSchema>;

/**
 * LLM often sends inventLogoCount: 0 when inventLogo is false — coerce to 1
 * instead of failing the whole ContinueIntent parse (which forces regex fallback).
 */
export const InventLogoCountSchema = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return 1;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(12, Math.round(n));
}, z.number().int().min(1).max(12));

/** Ordered media recipe steps for design-loop continues (orchestrator-executed). */
export const DesignAssetOpSchema = z.enum([
  "make_transparent",
  "circular_mask",
  "derive_icon_pack",
  "resize_image",
]);
export type DesignAssetOp = z.infer<typeof DesignAssetOpSchema>;

export const ContinueIntentSchema = z.object({
  scope: ContinueIntentScopeSchema,
  /** Sections/regions named for surgical changes. */
  targets: z.array(ContinueIntentTargetSchema).default([]),
  /** True when icon pack / alpha / resize media edits are requested. */
  wantsAssetEdit: z.boolean().default(false),
  /**
   * Ordered asset recipe (transparent → icon pack). When non-empty, orchestrator
   * runs these deterministically; inventLogo should be false for edit-of-pin asks.
   */
  assetOps: z.array(DesignAssetOpSchema).default([]),
  /** Operator asked for a new logo/mark (invent or adopt a new asset). */
  inventLogo: z.boolean().default(false),
  /**
   * How many logo variants to invent (from the operator prompt).
   * 1 = singular generate→pin; >1 = concept grid, no auto-pin.
   */
  inventLogoCount: InventLogoCountSchema.default(1),
  /** Operator asked to pull palette/theme from a sibling project. */
  adoptTheme: z.boolean().default(false),
  /**
   * Operator asked to reuse this project's existing theming/design pack
   * (fresh loop after a dirty one, or "pull current theming"). Note: fresh
   * loops INHERIT the current design by default — this flag is the express
   * ask; freshDesign / replaceDesignFacets are the override.
   */
  reuseProjectDesign: z.boolean().default(false),
  /**
   * Express clean-slate ask ("rebrand", "brand new look", "from scratch",
   * "complete redesign"): NOTHING inherits — theme, logo, graphics, and mock
   * layout are all replaced. Default false: inherit unless expressly told.
   */
  freshDesign: z.boolean().default(false),
  /**
   * Facets the operator expressly wants REPLACED on this loop (new theme, new
   * logo, new graphics, new layout). Everything NOT listed inherits from the
   * project's current design. freshDesign implies all four.
   */
  replaceDesignFacets: z.array(DesignFacetSchema).default([]),
  /**
   * Sibling project name / folder / path as stated when adoptTheme is true
   * (e.g. "jamroast-components"). Resolver uses this; do not regex-scan chat.
   */
  shareFrom: z.string().min(1).optional(),
  /**
   * Operator asked for full look-and-feel / chrome from a sibling (Menubar,
   * theme toggle, UserPill slots) — not palette-only.
   */
  adoptChrome: z.boolean().default(false),
  /** Align topbar nav with live code. */
  navAlign: z.boolean().default(false),
  /** Operator explicitly asked to keep layout/copy/shell/hero unchanged. */
  preserveChrome: z.boolean().default(false),
  /** Short operator-facing summary of what will change. */
  notes: z.string().default(""),
  /**
   * When set, narrow/widen the loop conceptual-model scope for this continue
   * (e.g. kind=component, focus=chat.composer).
   */
  designScope: DesignScopePatchSchema,
});
export type ContinueIntent = z.infer<typeof ContinueIntentSchema>;

export const CONTINUE_INTENT_DEFAULT: ContinueIntent = {
  scope: "sections",
  targets: [],
  wantsAssetEdit: false,
  assetOps: [],
  inventLogo: false,
  inventLogoCount: 1,
  adoptTheme: false,
  reuseProjectDesign: false,
  freshDesign: false,
  replaceDesignFacets: [],
  shareFrom: undefined,
  adoptChrome: false,
  navAlign: false,
  preserveChrome: true,
  notes: "",
  designScope: undefined,
};

/** Clamp invent variant count to 1–12. */
export function clampInventLogoCount(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(12, Math.round(v)));
}

/**
 * Offline extract of requested logo variant count from operator text.
 * Used only when inventLogo is true (fallback / tests).
 */
export function extractInventLogoCountFromText(text: string): number {
  const t = text ?? "";
  const patterns = [
    /\bgenerate\s+(\d{1,2})\s+(?:different\s+)?(?:logo|mark|symbol|variant)s?\b/i,
    /\b(\d{1,2})\s+different\s+(?:logo|mark|symbol|variant)s?\b/i,
    /\b(\d{1,2})\s+(?:logo|mark|symbol)\s+ideas?\b/i,
    /\b(?:logo|mark|symbol)\s+ideas?\s*[:\-]?\s*(\d{1,2})\b/i,
    /\b(?:make|create|produce|show|give\s+me)\s+(\d{1,2})\s+(?:\w+\s+){0,4}(?:logo|mark|symbol|variant)s?\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) return clampInventLogoCount(Number(m[1]));
  }
  return 1;
}

/**
 * Intentional theme/logo redesign — fingerprint drift must not veto the agent
 * mock when preserveChrome is false (LLM intent wins).
 */
export function continueIntentAllowsRedesign(intent: ContinueIntent): boolean {
  return (
    intent.adoptTheme ||
    intent.adoptChrome ||
    intent.reuseProjectDesign ||
    intent.inventLogo ||
    intent.scope === "adopt_theme" ||
    intent.scope === "logo_invent" ||
    intent.scope === "full_revise"
  );
}

/** True when the operator's intent replaces the given facet (else it inherits). */
export function continueIntentReplacesFacet(
  intent: ContinueIntent,
  facet: DesignFacet,
): boolean {
  return intent.replaceDesignFacets.includes(facet);
}

export function continueIntentAllowsTokenChurn(intent: ContinueIntent): boolean {
  return (
    continueIntentAllowsRedesign(intent) ||
    intent.targets.includes("palette") ||
    intent.targets.includes("tokens")
  );
}

export function continueIntentAllowsLogoSwap(intent: ContinueIntent): boolean {
  return (
    continueIntentAllowsRedesign(intent) || intent.targets.includes("logo")
  );
}

export function continueIntentMayTouchNav(intent: ContinueIntent): boolean {
  return (
    intent.navAlign ||
    continueIntentAllowsRedesign(intent) ||
    intent.adoptChrome ||
    intent.targets.includes("nav") ||
    intent.targets.includes("dashboard") ||
    intent.targets.includes("landing") ||
    // Menubar left/right / content-max layout often reshuffles nav DOM order.
    intent.targets.includes("shell") ||
    intent.targets.includes("layout")
  );
}

export function continueIntentMayTouchHero(intent: ContinueIntent): boolean {
  return (
    continueIntentAllowsRedesign(intent) ||
    intent.targets.includes("hero") ||
    intent.targets.includes("copy") ||
    intent.targets.includes("landing")
  );
}

export function continueIntentMayTouchShell(intent: ContinueIntent): boolean {
  return (
    continueIntentAllowsRedesign(intent) ||
    intent.adoptChrome ||
    intent.targets.includes("shell") ||
    intent.targets.includes("layout") ||
    intent.targets.includes("dashboard")
  );
}

/**
 * Deterministic regex fallback (offline / tests / LLM failure).
 * Prefer LLM classification via mastra; keep this conservative.
 */
export function fallbackContinueIntentFromText(text: string): ContinueIntent {
  const t = text ?? "";
  const targets = new Set<ContinueIntentTarget>();

  const assetOps = detectDesignAssetOpsFromText(t);
  const wantsAssetEdit = assetOps.length > 0;
  // Layout: centre menubar over page content — not LIVE SITE nav label sync.
  const menubarContentAlign = textSignalsMenubarContentAlign(t);
  const navAlign =
    !menubarContentAlign &&
    (/\b(align|match|sync|update)\b.{0,50}\b(menu|nav|navigation|header\s*links?)\b.{0,40}\b(code|today|current|in\s*place|exists|live|what\s+we\s+have)\b/i.test(
      t,
    ) ||
      /\b(menu|nav|navigation)\b.{0,50}\b(align|match|sync)\b.{0,40}\b(code|today|current|in\s*place|exists|live|what\s+we\s+have)\b/i.test(
        t,
      ) ||
      /\b(menu|nav|navigation).{0,80}\b(in\s+the\s+code|what\s+we\s+have|what\s+exists|what\s+is\s+in\s+place)\b/i.test(
        t,
      ));
  // Soft "update logo" near alpha/cutout must not invent; strong invent still wins.
  const inventLogo = textSignalsInventLogo(t, { hasAssetOps: wantsAssetEdit });
  const reuseProjectDesign = textSignalsReuseProjectDesign(t);
  // Sibling/cross-project only — same-project "current theming" is reuseProjectDesign.
  // Offline-only heuristics; success path uses LLM adoptTheme + shareFrom.
  const usingSiblingLib =
    /\b(?:using|with|from)\s+([\w.-]+-components)\b/i.exec(t) ??
    /\b(?:mock|design|theme|theming|look\s+and\s+feel)\b.{0,40}\b(?:using|from|with)\s+([\w.-]{3,})\b/i.exec(
      t,
    );
  const adoptTheme =
    !reuseProjectDesign &&
    (/\b(theme|theming|palette|brand\s*colors?)\b.{0,60}\b(from|of|like|borrow|pull|adopt)\b.{0,40}\b(sibling|other\s*project|\/(?:Users|home|var)\/)/i.test(
      t,
    ) ||
      /\b(pull|adopt|borrow|use)\b.{0,40}\b(theme|theming|palette)\b.{0,60}\b(sibling|other\s*project)\b/i.test(
        t,
      ) ||
      /\bfrom\s+\/(?:Users|home|var)\/[^/\s]+/i.test(t) ||
      /\b(theme|theming|palette|look\s+and\s+feel)\b.{0,40}\bfrom\s+[\w.-]{2,}\b/i.test(
        t,
      ) ||
      Boolean(usingSiblingLib));
  let shareFrom: string | undefined;
  if (adoptTheme) {
    const pathHit = t.match(/(\/(?:Users|home|var)\/[^\s"'`]+)/);
    const fromName = t.match(
      /\b(?:theme|theming|palette|design|mock)\b.{0,40}\bfrom\s+([\w.-]{3,})\b/i,
    );
    const raw =
      pathHit?.[1] ??
      usingSiblingLib?.[1] ??
      fromName?.[1];
    if (
      raw &&
      !/^(the|this|current|existing|prior|sibling|other|scratch)$/i.test(raw)
    ) {
      shareFrom = raw;
    }
  }
  const preserveChrome =
    /\b(?:keep|preserve|maintain)\b.{0,60}\b(layout|copy|shell|hero|structure|mock|menu|nav)\b/i.test(
      t,
    ) ||
    /\b(?:do\s+not|don't|dont)\s+(?:change|touch|alter|rewrite|modify)\b.{0,60}\b(layout|copy|shell|hero|structure|mock|menu|nav)\b/i.test(
      t,
    );

  // Positive section hints (strip negated keep/do-not-change spans first)
  const positiveScan = t
    .replace(
      /\b(?:do\s+not|don't|dont)\s+(?:change|touch|alter|rewrite|modify|update)\b[^.!?\n]*/gi,
      " ",
    )
    .replace(/\b(?:keep|preserve|maintain)\s+(?:the\s+)?[^.!?\n]*/gi, " ");
  const sectionPatterns: Array<{ id: ContinueIntentTarget; re: RegExp }> = [
    { id: "tasting-room", re: /\btasting\s*room\b/i },
    { id: "landing", re: /\b(landing|home\s*page)\b/i },
    { id: "dashboard", re: /\bdashboard\b/i },
    { id: "chat", re: /\b(chat|agent\s*panel)\b/i },
    { id: "settings", re: /\bsettings?\b/i },
    { id: "lockups", re: /\blockups?\b/i },
    { id: "palette", re: /\bpalette\b/i },
    { id: "typography", re: /\btypograph/i },
    { id: "hero", re: /\bhero\b/i },
    { id: "nav", re: /\b(nav|menu|navigation)\b/i },
  ];
  for (const p of sectionPatterns) {
    if (p.re.test(positiveScan)) targets.add(p.id);
  }
  if (inventLogo) targets.add("logo");
  if (adoptTheme || reuseProjectDesign) targets.add("palette");
  if (navAlign) targets.add("nav");
  if (menubarContentAlign) {
    targets.add("shell");
    targets.add("layout");
  }
  // Offline: look-and-feel / chrome from sibling → adoptChrome
  const adoptChrome =
    adoptTheme &&
    (/\blook\s+and\s+feel\b/i.test(t) ||
      /\b(match|adopt|pull)\b.{0,40}\b(chrome|menubar|shell|ui)\b/i.test(t) ||
      /\b(menubar|theme-?toggle|user\s*pill)\b/i.test(t) ||
      Boolean(usingSiblingLib));
  if (adoptChrome) {
    targets.add("shell");
    targets.add("layout");
  }

  const wantsFull =
    /\b(redesign|from scratch|rewrite\s+(the\s+)?(whole|entire|full)|overhaul|new\s+layout|restyle\s+everything|start\s+over)\b/i.test(
      t,
    );

  let scope: ContinueIntentScope = "sections";
  if (wantsFull && !preserveChrome && !navAlign && !reuseProjectDesign)
    scope = "full_revise";
  else if (navAlign && !inventLogo && !menubarContentAlign) scope = "nav_align";
  else if (inventLogo && !adoptTheme && !reuseProjectDesign && targets.size <= 1)
    scope = "logo_invent";
  else if (
    (adoptTheme || reuseProjectDesign) &&
    !inventLogo &&
    targets.size <= 2
  )
    scope = "adopt_theme";
  else if (
    wantsAssetEdit &&
    !inventLogo &&
    (targets.size === 0 || preserveChrome)
  )
    scope = "assets_only";
  else if (inventLogo || adoptTheme || reuseProjectDesign || menubarContentAlign)
    scope = "sections";

  // Theme/logo redesign: preserveChrome only when operator explicitly said keep.
  // Narrow asset/nav continues default to preserving chrome.
  const redesign =
    inventLogo || adoptTheme || reuseProjectDesign || scope === "full_revise";
  const preserve =
    preserveChrome ||
    (!redesign && (scope === "assets_only" || scope === "nav_align"));

  // Narrow conceptual model when operator says "only the chat form" etc.
  let designScope: ContinueIntent["designScope"];
  if (
    /\b(only|just)\b.{0,40}\b(form|composer|bubble|panel|modal)\b/i.test(t) ||
    /\bchat\s*(form|composer|prompt)\b/i.test(t)
  ) {
    const focus =
      t.match(/\b(chat\s*)?(form|composer|prompt|bubble)\b/i)?.[0]
        ?.toLowerCase()
        .replace(/\s+/g, ".") ?? "chat.composer";
    designScope = {
      kind: "component",
      focus,
      preserve: ["chrome", "palette", "logo", "nav", "shell"],
    };
  } else if (
    /\b(dark\s*(and|&|\/)\s*light|theme\s*toggle)\b/i.test(t) &&
    !/\b(brand|landing|agency)\b/i.test(t)
  ) {
    designScope = {
      kind: "shell",
      focus: "theme",
      preserve: ["logo", "content"],
    };
  } else if (menubarContentAlign) {
    designScope = {
      kind: "shell",
      focus: "menubar",
      preserve: ["logo", "palette", "content"],
    };
  } else if (wantsFull && !preserveChrome) {
    designScope = { kind: "product", focus: "site", preserve: [] };
  }

  return normalizeContinueIntentStructured(
    ContinueIntentSchema.parse({
      scope,
      targets: [...targets],
      wantsAssetEdit,
      assetOps,
      inventLogo,
      inventLogoCount: inventLogo ? extractInventLogoCountFromText(t) : 1,
      adoptTheme,
      reuseProjectDesign,
      freshDesign: textSignalsFreshDesign(t),
      replaceDesignFacets: extractReplaceDesignFacetsFromText(t),
      shareFrom,
      adoptChrome,
      navAlign,
      preserveChrome: preserve && !adoptChrome,
      notes: "",
      designScope: adoptChrome
        ? designScope ?? {
            kind: "shell" as const,
            focus: "menubar",
            preserve: ["logo", "palette", "content"],
          }
        : designScope,
    }),
  );
}

/**
 * True when operator asks to centre/align the menubar with page content width
 * (layout), not sync nav labels with live code (`navAlign`).
 */
export function textSignalsMenubarContentAlign(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(?:centre|center|centred|centered)\b.{0,80}\b(?:menu\s*bar|menubar|nav\s*bar)\b/i.test(
      t,
    ) ||
    /\b(?:menu\s*bar|menubar|nav\s*bar)\b.{0,100}\b(?:centre|center|same\s+width|content\s+width|page\s+content|landing\s+content|contents?\s+(?:on|of|in)\s+the\s+page)\b/i.test(
      t,
    ) ||
    /\b(?:same\s+width|align(?:ed)?\s+(?:with|over))\b.{0,60}\b(?:contents?\s+(?:on|of|in)\s+the\s+page|page\s+content|landing\s+content)\b/i.test(
      t,
    ) ||
    (/\b(?:logo|menu\s*items?)\b.{0,40}\bleft\s*align/i.test(t) &&
      /\b(?:sign\s*in|theme|day\s*(?:\/|&|and)?\s*night|toggle)\b.{0,40}\bright\s*align/i.test(
        t,
      ))
  );
}

/**
 * Express clean-slate ask for THIS project — rebrand / brand new look /
 * complete redesign / from scratch. Default-inherit means only explicit
 * "start over" language sets this; vague "new page" briefs do not.
 */
export function textSignalsFreshDesign(text: string): boolean {
  const t = text ?? "";
  return (
    /\brebrand\b/i.test(t) ||
    /\bbrand\s+new\s+(?:look|design|theme|identity|brand)\b/i.test(t) ||
    /\bnew\s+brand\s+identity\b/i.test(t) ||
    /\bclean\s+slate\b/i.test(t) ||
    /\bfrom\s+scratch\b/i.test(t) ||
    /\bstart\s+over\b/i.test(t) ||
    /\bcomplete(?:ly)?\s+(?:redesign|re-?design|overhaul)\b/i.test(t) ||
    /\b(?:total|full|complete)\s+(?:redesign|overhaul)\b/i.test(t) ||
    /\b(?:scrap|ditch|drop|replace)\b.{0,40}\b(?:current|existing|prior)\b.{0,40}\b(?:design|theme|theming|brand)\b/i.test(
      t,
    )
  );
}

/**
 * Offline facet extraction: which design facets the operator expressly wants
 * replaced. Conservative — inherit-by-default means we only carve out a facet
 * on explicit replacement language. (Logo is handled via inventLogo in
 * normalize; graphics/layout/theme patterns here.)
 */
export function extractReplaceDesignFacetsFromText(text: string): DesignFacet[] {
  const t = text ?? "";
  const facets = new Set<DesignFacet>();
  if (textSignalsFreshDesign(t)) return [...ALL_DESIGN_FACETS];
  if (textSignalsInventLogo(t)) facets.add("logo");
  if (
    /\b(?:new|different|fresh|replace|redo|change|updated?)\b.{0,40}\b(?:theme|theming|palettes?|colo(?:u)?r\s*scheme|colo(?:u)?rs?|typography|tokens?)\b/i.test(
      t,
    ) ||
    /\b(?:theme|theming|palettes?|colo(?:u)?r\s*scheme|typography|tokens?)\b.{0,40}\b(?:new|different|fresh|replace|redo)\b/i.test(
      t,
    )
  ) {
    facets.add("theme");
  }
  if (
    /\b(?:new|different|fresh|replace|regenerate)\b.{0,40}\b(?:graphics?|images?|illustrations?|photos?|artwork|hero\s+(?:image|art|graphic)s?)\b/i.test(
      t,
    ) ||
    /\b(?:graphics?|images?|illustrations?|artwork)\b.{0,40}\b(?:new|different|fresh|replace|regenerate)\b/i.test(
      t,
    )
  ) {
    facets.add("graphics");
  }
  if (
    /\b(?:new|different|fresh|replace|redo|change)\b.{0,30}\blayout\b/i.test(t) ||
    /\blayout\b.{0,30}\b(?:new|different|fresh|replace|redo)\b/i.test(t) ||
    /\b(?:new|different)\s+(?:page\s+)?structure\b/i.test(t)
  ) {
    facets.add("layout");
  }
  return [...facets];
}

/**
 * True when operator asks to reuse this project's existing theming / design pack
 * (not a named sibling). Used on design_loop_start briefs and continues.
 */
export function textSignalsReuseProjectDesign(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(current|existing|prior|previous)\b.{0,48}\b(theming|theme|design\s*(pack|concepts?|system|tokens?)|tokens|palette)\b/i.test(
      t,
    ) ||
    /\b(theming|theme|design\s*(pack|concepts?|system)|tokens|palette)\b.{0,48}\b(current|existing|already\s+(?:have|in\s+place|designed)|we\s+have|in\s+place)\b/i.test(
      t,
    ) ||
    /\b(pull\s+out|pull\s+in|reuse|use)\b.{0,40}\b(the\s+)?(current|existing|prior)\b.{0,40}\b(theming|theme|design)\b/i.test(
      t,
    ) ||
    /\b(use|reuse|pull)\b.{0,40}\b(design\s*pack|DESIGN_PACK|what\s+we\s+already\s+have)\b/i.test(
      t,
    ) ||
    /\bexisting\s+design\s+concepts?\b/i.test(t)
  );
}

/**
 * Detect ordered design-asset recipe steps from operator text.
 * Order: chroma → circular mask → icon pack when several apply.
 * "cut out the circular logo" → circular_mask (primary); flat plate /
 * black-bg without circular → make_transparent.
 */
export function detectDesignAssetOpsFromText(text: string): DesignAssetOp[] {
  const t = text ?? "";
  const ops: DesignAssetOp[] = [];
  const wantsCircularCut =
    /\bcircular\b/i.test(t) &&
    /\b(cut\s*out|alpha|transparent|transparency|remove\s*background|mask|circular_mask)\b/i.test(
      t,
    );
  const wantsTransparent =
    /\b(alpha(?:\s*channel)?|transparent|transparency|remove\s*background|strip\s*black|cut\s*out|chroma|make_transparent|black\s*(?:background|square)|key\s*out)\b/i.test(
      t,
    );
  const wantsPlateKey =
    /\b(black\s*(?:background|square)|strip\s*black|chroma|alpha(?:\s*channel)?|transparent|transparency|key\s*out|make_transparent)\b/i.test(
      t,
    );
  const wantsIconPack =
    /\b(icon\s*pack|favicon|browser\s*(?:icon\s*)?pack|derive_icon)\b/i.test(t);
  const wantsResize =
    /\b(resize|trim|pad\s*image|resize_image)\b/i.test(t) &&
    !wantsIconPack;
  if (wantsCircularCut) {
    if (wantsPlateKey) ops.push("make_transparent");
    ops.push("circular_mask");
  } else if (wantsTransparent) {
    ops.push("make_transparent");
  }
  if (wantsIconPack) ops.push("derive_icon_pack");
  if (wantsResize) ops.push("resize_image");
  return ops;
}

/** Strong invent: new/different mark, dislike, generate N logos — not alpha edits. */
export function textSignalsStrongInventLogo(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(new|invent|generate|redo|replace|different|another)\b.{0,40}\b(logo|mark|symbol|monogram|brand\s*mark)s?\b/i.test(
      t,
    ) ||
    /\b(logo|mark|symbol|monogram)s?\b.{0,40}\b(new|invent|generate|replace|different|another|redo)\b/i.test(
      t,
    ) ||
    /\b(symbolic|new)\s+(mark|logo)s?\b/i.test(t) ||
    /\binvent\b.{0,40}\b(logo|mark)s?\b/i.test(t) ||
    /\b(unhappy|not\s+happy|don't\s+like|dont\s+like|do\s+not\s+like|dislike|hate|looks?\s+bad|not\s+working)\b.{0,60}\b(logo|mark|symbol|monogram)s?\b/i.test(
      t,
    ) ||
    /\b(logo|mark|symbol|monogram)s?\b.{0,40}\b(unhappy|don't\s+like|dont\s+like|dislike|hate|looks?\s+bad|wrong|awful|terrible)\b/i.test(
      t,
    ) ||
    // "create a logo" / "design a mark" without alpha/cutout context
    (/\b(create|design)\b.{0,40}\b(logo|mark|symbol|monogram)s?\b/i.test(t) &&
      detectDesignAssetOpsFromText(t).length === 0)
  );
}

/** Soft invent cues alone ("update/change the logo") — suppressed when assetOps present. */
export function textSignalsSoftInventLogo(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(change|swap|update)\b.{0,20}\b(the\s+)?(logo|mark)s?\b/i.test(t) ||
    /\b(logo|mark)s?\b.{0,20}\b(change|swap|update|replace)\b/i.test(t)
  );
}

/**
 * True when operator prose asks to invent/replace/dislike the current logo.
 * Soft update/change cues do not invent when an asset recipe is present.
 */
export function textSignalsInventLogo(
  text: string,
  opts?: { hasAssetOps?: boolean },
): boolean {
  if (textSignalsStrongInventLogo(text)) return true;
  const hasOps =
    opts?.hasAssetOps ?? detectDesignAssetOpsFromText(text).length > 0;
  if (hasOps) return false;
  return textSignalsSoftInventLogo(text);
}

/**
 * Schema-only coherence after LLM (or fallback) classification.
 * When inventLogo and assetOps both set, prefer the asset recipe (edit-first).
 */
export function normalizeContinueIntentStructured(
  intent: ContinueIntent,
): ContinueIntent {
  let inventLogo = intent.inventLogo;
  let assetOps = [...(intent.assetOps ?? [])];
  // Compound asks: "update logo with alpha + icon pack" must not invent.
  if (assetOps.length > 0 && inventLogo) {
    inventLogo = false;
  }
  if (inventLogo) {
    assetOps = [];
  }
  const wantsAssetEdit = assetOps.length > 0;
  const reuseProjectDesign = intent.reuseProjectDesign;
  // Facet derivation: express clean-slate replaces everything; an express
  // new-logo ask carves out the logo facet. Everything else inherits.
  const facetSet = new Set<DesignFacet>(intent.replaceDesignFacets ?? []);
  if (intent.freshDesign) {
    for (const f of ALL_DESIGN_FACETS) facetSet.add(f);
  }
  if (inventLogo) facetSet.add("logo");
  const replaceDesignFacets = [...facetSet];
  const adoptTheme = !reuseProjectDesign && intent.adoptTheme;
  const adoptChrome = Boolean(intent.adoptChrome);
  const menubarLayout =
    (intent.targets.includes("shell") && intent.targets.includes("layout")) ||
    adoptChrome;

  let scope = intent.scope;
  if (wantsAssetEdit && !inventLogo) {
    if (
      scope === "logo_invent" ||
      (scope === "sections" &&
        intent.targets.every((x) => x === "logo" || x === undefined))
    ) {
      scope = "assets_only";
    }
  }
  if (inventLogo && scope === "assets_only") {
    scope =
      !adoptTheme &&
      !reuseProjectDesign &&
      intent.targets.every((x) => x === "logo")
        ? "logo_invent"
        : "sections";
  }
  if (inventLogo && !adoptTheme && !reuseProjectDesign && scope === "sections") {
    const onlyLogo =
      intent.targets.length === 0 ||
      intent.targets.every((x) => x === "logo");
    if (onlyLogo) scope = "logo_invent";
  }
  if (
    reuseProjectDesign &&
    !inventLogo &&
    (scope === "full_revise" || scope === "sections")
  ) {
    scope = "adopt_theme";
  }
  if (adoptTheme && !inventLogo && scope === "full_revise") {
    scope = "adopt_theme";
  }
  if (menubarLayout && scope === "nav_align") {
    scope = "sections";
  }
  if (
    wantsAssetEdit &&
    !inventLogo &&
    !adoptTheme &&
    !reuseProjectDesign &&
    !adoptChrome &&
    (scope === "sections" || scope === "logo_invent") &&
    (intent.targets.length === 0 ||
      intent.targets.every((x) => x === "logo") ||
      intent.preserveChrome)
  ) {
    scope = "assets_only";
  }

  const targets = new Set(intent.targets);
  if (inventLogo) targets.add("logo");
  if (wantsAssetEdit) targets.add("logo");
  if (adoptTheme || reuseProjectDesign) targets.add("palette");
  if (adoptChrome) {
    targets.add("shell");
    targets.add("layout");
  }

  const designScope =
    menubarLayout && !intent.designScope
      ? {
          kind: "shell" as const,
          focus: "menubar",
          preserve: ["logo", "palette", "content"],
        }
      : intent.designScope;

  const shareFrom =
    (adoptTheme || adoptChrome) && intent.shareFrom?.trim()
      ? intent.shareFrom.trim()
      : undefined;

  // Trust structured preserveChrome; redesign/chrome asks typically set false via LLM.
  const preserveChrome =
    adoptChrome && !intent.preserveChrome ? false : intent.preserveChrome;

  const inventLogoCount = inventLogo
    ? clampInventLogoCount(intent.inventLogoCount ?? 1)
    : 1;

  return ContinueIntentSchema.parse({
    ...intent,
    scope,
    targets: [...targets],
    inventLogo,
    inventLogoCount,
    assetOps,
    wantsAssetEdit,
    adoptTheme,
    reuseProjectDesign,
    replaceDesignFacets,
    adoptChrome,
    shareFrom,
    navAlign: menubarLayout ? false : intent.navAlign,
    preserveChrome,
    designScope,
  });
}

/**
 * @deprecated Prefer normalizeContinueIntentStructured. Text arg ignored —
 * kept so call sites compile during migration; does not re-scan chat.
 */
export function normalizeContinueIntent(
  intent: ContinueIntent,
  _text?: string,
): ContinueIntent {
  return normalizeContinueIntentStructured(intent);
}

/** Prompt block for the design agent describing allowed scope. */
export function formatContinueIntentPromptBlock(
  intent: ContinueIntent,
): string {
  const lines = [
    `CONTINUE INTENT: ${intent.scope}`,
    intent.preserveChrome && intent.scope !== "full_revise"
      ? "- Preserve layout, hero copy, shell, and nav unless a target below explicitly includes them."
      : "- Full revise allowed; still prefer pinned logos over inventing a new mark unless inventLogo is set.",
  ];
  if (intent.wantsAssetEdit || intent.assetOps?.length) {
    const ops =
      intent.assetOps?.length > 0
        ? intent.assetOps.join(" → ")
        : "make_transparent / circular_mask / derive_icon_pack / resize_image";
    lines.push(
      `- Asset recipe (${ops}): edit the EXISTING pinned logo — do NOT call generate_image / inventNew.`,
    );
  }
  if (intent.navAlign) {
    lines.push(
      "- NAV ALIGN: topbar/primary nav labels+hrefs must match LIVE SITE inventory (system may patch deterministically).",
    );
  }
  if (
    intent.targets.includes("shell") &&
    intent.targets.includes("layout") &&
    !intent.navAlign
  ) {
    lines.push(
      "- MENUBAR LAYOUT: centre an inner bar at var(--content-max) matching page content; logo+nav left, auth/theme right — not LIVE SITE nav label sync.",
    );
  }
  if (intent.inventLogo) {
    const count = clampInventLogoCount(intent.inventLogoCount ?? 1);
    if (count > 1) {
      lines.push(
        `- NEW LOGO VARIANTS (${count}): prior logo pin is superseded. Call generate_image with inventNew=true exactly ${count} times with distinct style prompts and filenames (concept-a …). Embed all as a logo-card / Concept A–${String.fromCharCode(64 + Math.min(count, 26))} grid in the mock. Do NOT call pin_logo — operator will pick later.`,
      );
    } else {
      lines.push(
        "- NEW LOGO: prior logo pin is superseded. Call generate_image with inventNew=true, embed the new asset, then pin_logo that filename.",
      );
    }
  }
  if (intent.adoptTheme) {
    lines.push(
      "- ADOPT THEME: apply sibling palette/token excerpts (incl. dark/light ladders) over prior mock tokens; LIVE SITE stays authoritative for nav/routes/screen copy only.",
    );
    if (intent.shareFrom?.trim()) {
      lines.push(`- Share source (stated): ${intent.shareFrom.trim()}.`);
    }
  }
  if (intent.adoptChrome) {
    lines.push(
      "- ADOPT CHROME / LOOK-AND-FEEL: apply SHARED DESIGN shell contract (content-max menubar; logo+nav left; auth/theme right). Prefer pinned theme-toggle element — do NOT invent a competing pill/day-night control.",
    );
  }
  if (intent.reuseProjectDesign) {
    lines.push(
      "- REUSE PROJECT DESIGN: apply this project's prior DESIGN_PACK / phase design tokens and mock (PRIOR DESIGN). Do not invent a new palette; revise from that mock. LIVE SITE wins only for nav/routes/screen copy.",
    );
  }
  if (intent.freshDesign) {
    lines.push(
      "- FRESH DESIGN: operator expressly asked for a clean slate — do NOT reuse prior theme, mock, logo, or graphics. Invent a new design system.",
    );
  } else if (intent.replaceDesignFacets.length) {
    lines.push(
      `- REPLACE ONLY: ${intent.replaceDesignFacets.join(", ")} — every other facet (theme, logo, graphics, layout) inherits from the project's current design/brand assets. Do not redesign what was not asked for.`,
    );
  }
  if (intent.targets.length) {
    lines.push(`- Change targets: ${intent.targets.join(", ")}.`);
  }
  if (intent.notes.trim()) {
    lines.push(`- Summary: ${intent.notes.trim().slice(0, 300)}`);
  }
  return lines.join("\n");
}
