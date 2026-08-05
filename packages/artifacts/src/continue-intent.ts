/**
 * Structured intent for design-loop continues.
 *
 * Regex classification is the deterministic fallback only; primary path is an
 * LLM JSON call in mastra (`classifyContinueIntentWithLlm`). Drift gating
 * consumes these explicit targets/allow-flags instead of inferring from kind.
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

/** Optional conceptual-model scope patch from continue classification. */
export const DesignScopePatchSchema = z
  .object({
    kind: z.enum(["product", "shell", "screen", "component", "flow"]).optional(),
    focus: z.string().min(1).optional(),
    preserve: z.array(z.string()).optional(),
  })
  .optional();
export type DesignScopePatch = z.infer<typeof DesignScopePatchSchema>;

export const ContinueIntentSchema = z.object({
  scope: ContinueIntentScopeSchema,
  /** Sections/regions named for surgical changes. */
  targets: z.array(ContinueIntentTargetSchema).default([]),
  /** True when icon pack / alpha / resize media edits are requested. */
  wantsAssetEdit: z.boolean().default(false),
  /** Operator asked for a new logo/mark (invent or adopt a new asset). */
  inventLogo: z.boolean().default(false),
  /** Operator asked to pull palette/theme from a sibling project. */
  adoptTheme: z.boolean().default(false),
  /**
   * Operator asked to reuse this project's existing theming/design pack
   * (fresh loop after a dirty one, or "pull current theming").
   */
  reuseProjectDesign: z.boolean().default(false),
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
  inventLogo: false,
  adoptTheme: false,
  reuseProjectDesign: false,
  navAlign: false,
  preserveChrome: true,
  notes: "",
  designScope: undefined,
};

/**
 * Intentional theme/logo redesign — fingerprint drift must not veto the agent
 * mock when preserveChrome is false (LLM intent wins).
 */
export function continueIntentAllowsRedesign(intent: ContinueIntent): boolean {
  return (
    intent.adoptTheme ||
    intent.reuseProjectDesign ||
    intent.inventLogo ||
    intent.scope === "adopt_theme" ||
    intent.scope === "logo_invent" ||
    intent.scope === "full_revise"
  );
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
    intent.targets.includes("nav") ||
    intent.targets.includes("dashboard") ||
    intent.targets.includes("landing")
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
    intent.targets.includes("shell") ||
    intent.targets.includes("dashboard")
  );
}

/**
 * Deterministic regex fallback (offline / tests / LLM failure).
 * Prefer LLM classification via mastra; keep this conservative.
 */
export function fallbackContinueIntentFromText(text: string): ContinueIntent {
  const t = text ?? "";
  const lower = t.toLowerCase();
  const targets = new Set<ContinueIntentTarget>();

  const wantsAssetEdit =
    /\b(alpha|transparent|transparency|remove\s*background|icon\s*pack|favicon|resize|trim|pad\s*image|make_transparent|derive_icon)\b/i.test(
      t,
    );
  const navAlign =
    /\b(align|match|sync|update)\b.{0,50}\b(menu|nav|navigation|header\s*links?)\b/i.test(
      t,
    ) ||
    /\b(menu|nav|navigation)\b.{0,50}\b(align|match|code|today|current|in\s*place|exists|live)\b/i.test(
      t,
    ) ||
    /\b(menu|nav|navigation).{0,80}\b(in\s+the\s+code|what\s+we\s+have|what\s+exists|what\s+is\s+in\s+place)\b/i.test(
      t,
    );
  const inventLogo = textSignalsInventLogo(t);
  const reuseProjectDesign = textSignalsReuseProjectDesign(t);
  // Sibling/cross-project only — same-project "current theming" is reuseProjectDesign.
  const adoptTheme =
    !reuseProjectDesign &&
    (/\b(theme|theming|palette|brand\s*colors?)\b.{0,60}\b(from|of|like|borrow|pull|adopt)\b.{0,40}\b(sibling|other\s*project|\/(?:Users|home|var)\/)/i.test(
      t,
    ) ||
      /\b(pull|adopt|borrow|use)\b.{0,40}\b(theme|theming|palette)\b.{0,60}\b(sibling|other\s*project)\b/i.test(
        t,
      ) ||
      /\bfrom\s+\/(?:Users|home|var)\/[^/\s]+/i.test(t) ||
      /\b(theme|theming|palette)\b.{0,40}\bfrom\s+[\w.-]{2,}\b/i.test(t));
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

  const wantsFull =
    /\b(redesign|from scratch|rewrite\s+(the\s+)?(whole|entire|full)|overhaul|new\s+layout|restyle\s+everything|start\s+over)\b/i.test(
      t,
    );

  let scope: ContinueIntentScope = "sections";
  if (wantsFull && !preserveChrome && !navAlign && !reuseProjectDesign)
    scope = "full_revise";
  else if (navAlign && !inventLogo) scope = "nav_align";
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
  else if (inventLogo || adoptTheme || reuseProjectDesign) scope = "sections";

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
  } else if (wantsFull && !preserveChrome) {
    designScope = { kind: "product", focus: "site", preserve: [] };
  }

  return normalizeContinueIntent(
    ContinueIntentSchema.parse({
      scope,
      targets: [...targets],
      wantsAssetEdit,
      inventLogo,
      adoptTheme,
      reuseProjectDesign,
      navAlign,
      preserveChrome: preserve,
      notes: "",
      designScope,
    }),
    t,
  );
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

/** True when operator prose asks to invent/replace/dislike the current logo. */
export function textSignalsInventLogo(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(new|invent|create|generate|design|redo|replace|different|another)\b.{0,40}\b(logo|mark|symbol|monogram|brand\s*mark)s?\b/i.test(
      t,
    ) ||
    /\b(logo|mark|symbol|monogram)s?\b.{0,40}\b(new|invent|create|generate|replace|different|another|redo)\b/i.test(
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
    /\b(change|swap|update)\b.{0,20}\b(the\s+)?(logo|mark)s?\b/i.test(t) ||
    /\b(logo|mark)s?\b.{0,20}\b(change|swap|update|replace)\b/i.test(t)
  );
}

/**
 * Post-classify normalize: invent/theme cues from text override weak LLM
 * fields; invent never lands on assets_only; redesign clears preserveChrome
 * unless the operator explicitly asked to keep chrome.
 */
export function normalizeContinueIntent(
  intent: ContinueIntent,
  text: string,
): ContinueIntent {
  const t = text ?? "";
  const inventFromText = textSignalsInventLogo(t);
  const inventLogo = intent.inventLogo || inventFromText;
  const reuseFromText = textSignalsReuseProjectDesign(t);
  const reuseProjectDesign = intent.reuseProjectDesign || reuseFromText;
  const adoptTheme =
    !reuseProjectDesign &&
    (intent.adoptTheme ||
      (/\b(theme|theming|palette|brand|skin)\b/i.test(t) &&
        /\b(from|pull|adopt|borrow)\b/i.test(t) &&
        (/\b(sibling|other\s*project)\b/i.test(t) ||
          /\bfrom\s+\/(?:Users|home|var)\//i.test(t) ||
          (/\bfrom\s+[\w.-]{2,}\b/i.test(t) &&
            !/\bfrom\s+(the\s+)?(current|existing|prior)\b/i.test(t)))));

  const explicitKeepChrome =
    /\b(?:keep|preserve|maintain)\b.{0,60}\b(layout|copy|shell|hero|structure|mock|menu|nav)\b/i.test(
      t,
    ) ||
    /\b(?:do\s+not|don't|dont)\s+(?:change|touch|alter|rewrite|modify)\b.{0,60}\b(layout|copy|shell|hero|structure|mock|menu|nav)\b/i.test(
      t,
    );

  const redesign =
    inventLogo ||
    adoptTheme ||
    reuseProjectDesign ||
    intent.scope === "full_revise" ||
    intent.scope === "logo_invent" ||
    intent.scope === "adopt_theme";

  let scope = intent.scope;
  if (inventLogo && scope === "assets_only") {
    scope =
      inventLogo &&
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

  const targets = new Set(intent.targets);
  if (inventLogo) targets.add("logo");
  if (adoptTheme || reuseProjectDesign) targets.add("palette");

  const preserveChrome = redesign
    ? explicitKeepChrome
    : intent.preserveChrome;

  return ContinueIntentSchema.parse({
    ...intent,
    scope,
    targets: [...targets],
    inventLogo,
    adoptTheme,
    reuseProjectDesign,
    preserveChrome,
    // Invent/replace is not an alpha/icon-pack edit path.
    wantsAssetEdit: inventLogo ? false : intent.wantsAssetEdit,
  });
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
  if (intent.wantsAssetEdit) {
    lines.push(
      "- Asset edits allowed via make_transparent / derive_icon_pack / resize_image tools.",
    );
  }
  if (intent.navAlign) {
    lines.push(
      "- NAV ALIGN: topbar/primary nav labels+hrefs must match LIVE SITE inventory (system may patch deterministically).",
    );
  }
  if (intent.inventLogo) {
    lines.push(
      "- NEW LOGO: prior logo pin is superseded. Call generate_image with inventNew=true, embed the new asset, then pin_logo that filename.",
    );
  }
  if (intent.adoptTheme) {
    lines.push(
      "- ADOPT THEME: apply sibling palette/token excerpts (incl. dark/light ladders) over prior mock tokens; LIVE SITE stays authoritative for nav/routes/screen copy only.",
    );
  }
  if (intent.reuseProjectDesign) {
    lines.push(
      "- REUSE PROJECT DESIGN: apply this project's prior DESIGN_PACK / phase design tokens and mock (PRIOR DESIGN). Do not invent a new palette; revise from that mock. LIVE SITE wins only for nav/routes/screen copy.",
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
