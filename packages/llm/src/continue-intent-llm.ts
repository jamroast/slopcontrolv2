import {
  ContinueIntentSchema,
  normalizeContinueIntentStructured,
  type ContinueIntent,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const CONTINUE_INTENT_SYSTEM_PROMPT = `You classify a design-loop start brief or continue request into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences, no apology, no "we are asking" narration — JSON object only.

Return ONLY a JSON object with these fields:
- scope: one of "assets_only" | "nav_align" | "logo_invent" | "adopt_theme" | "sections" | "full_revise"
- targets: string[] — subset of ["hero","copy","nav","logo","palette","tokens","typography","shell","layout","tasting-room","landing","dashboard","chat","settings","lockups"] the operator wants changed
- wantsAssetEdit: boolean — true when icon pack / alpha / transparency / cut-out / resize image edits are requested on an EXISTING asset
- assetOps: string[] — ordered recipe subset of ["make_transparent","circular_mask","derive_icon_pack","resize_image"]. Empty when no media edit. Order: transparent → circular_mask → icon pack when several apply.
- inventLogo: boolean — true ONLY when the operator asks for a NEW logo/mark/symbol (invent or adopt a different asset), not when editing the current pin
- inventLogoCount: number (1–12) — how many logo variants to invent. Bare "new logo" / "invent a mark" → 1. "generate 7 different logos" / "7 logo ideas" / "make 5 marks" → that count. Cap at 12. When inventLogo is false, omit inventLogoCount or set 1 — never 0.
- adoptTheme: boolean — true when the operator asks to pull palette/theme/branding/components from another project/sibling (including "using the components library", "mock with X", "from ProjectY")
- reuseProjectDesign: boolean — true when the operator asks to reuse THIS project's existing/current theming, design pack, or design concepts (not a named sibling). NOTE: fresh loops inherit the current design BY DEFAULT — set this only for express reuse asks; it is never required for inheritance to happen.
- freshDesign: boolean — true ONLY when the operator expressly asks for a clean slate for THIS project: "rebrand", "brand new look/design/theme", "new brand identity", "clean slate", "from scratch", "start over", "complete/total redesign or overhaul", "scrap/ditch the current design". Default false. When true, NOTHING inherits (theme, logo, graphics, layout all replaced).
- replaceDesignFacets: string[] — facets the operator expressly wants REPLACED or NEW, subset of ["theme","logo","graphics","layout"]. Everything NOT listed inherits from the project's current design and pinned brand assets. Map replacement language precisely: "new logo/mark" → ["logo"]; "new theme/palette/colors/typography" → ["theme"]; "new graphics/images/hero art/illustrations" → ["graphics"]; "new layout/structure" → ["layout"]. Multiple allowed ("new theme and graphics" → ["theme","graphics"]). Empty when nothing is expressly replaced. For full clean-slate asks use freshDesign=true instead of listing all four.
- adoptChrome: boolean — true when the operator wants the sibling's full look-and-feel / chrome (Menubar slots, theme toggle, auth pill) — not palette-only
- shareFrom: optional string — when adoptTheme or adoptChrome is true, the sibling project name, folder basename, or absolute path as the operator stated (e.g. "components-lib"). Omit when not adopting from a sibling.
- navAlign: boolean — true when the operator asks to align menus/nav with what exists in code
- preserveChrome: boolean — true when the operator explicitly says keep/do not change layout, hero, shell, copy, or nav
- notes: string — 1 sentence summary of what should change
- designScope: optional object to narrow/widen the conceptual model — { kind: "product"|"shell"|"screen"|"component"|"flow", focus: string, preserve?: string[] }. Omit when scope should stay unchanged. Use component+focus for "only the chat form/composer"; shell+focus "theme" for dark/light toggle work; product+focus "site" only for explicit whole-site redesign.

Rules:
- INHERIT BY DEFAULT: a fresh loop always inherits the project's current theming, pinned brand assets, and prior mock unless the operator expressly says otherwise. freshDesign and replaceDesignFacets are the ONLY override signals — vague briefs like "create a dashboard mock" or "new landing page" inherit everything (freshDesign=false, replaceDesignFacets=[]).
- Facet precision: "new logo" replaces ONLY the logo (theme, graphics, layout inherit). "new theme" replaces ONLY theme (logo, graphics, layout inherit). Only a full clean-slate ask (rebrand / from scratch / complete redesign) sets freshDesign=true.
- Fresh start briefs AND continues use the same schema. A start that says "create a mock using the components library" is adoptTheme + shareFrom, not inventing a blank palette.
- Example: "rebrand — completely new look, start over" → freshDesign=true, scope=full_revise, preserveChrome=false, replaceDesignFacets=[]. Example: "new theme and graphics, keep the logo" → replaceDesignFacets=["theme","graphics"], freshDesign=false, inventLogo=false.
- "new logo" / "symbolic mark" / "invent a mark" / "replace the logos" / "different logo" / "I am unhappy with the logos" / "don't like the current logos" → inventLogo=true, inventLogoCount=1 unless a number is stated, targets include "logo", replaceDesignFacets includes "logo", assetOps=[]. Never assets_only for these. Set preserveChrome=false unless the operator explicitly says keep layout/hero/shell.
- Soft phrases like "update logo" / "change the logo" / "produce an updated logo" WITH alpha / cut out / black background / icon pack → inventLogo=false, wantsAssetEdit=true, assetOps as below, scope=assets_only. Soft "change the logo" ALONE (no media-edit language) → inventLogo=true.
- "cut out the circular logo" / circular + cut-out → assetOps includes "circular_mask" (primary). inventLogo=false.
- "cut out the logo" / "remove black background" / "alpha channel" / "make transparent" without circular → assetOps includes "make_transparent", inventLogo=false.
- Circular + black background / alpha channel → ["make_transparent","circular_mask"] (chroma then geometry).
- "icon pack" / "favicon" / "browser icon pack" → assetOps includes "derive_icon_pack", inventLogo=false (unless they also strongly invent a new mark).
- Example: "cut out the circular logo." → scope=assets_only, inventLogo=false, wantsAssetEdit=true, assetOps=["circular_mask"], targets=["logo"].
- Example: "cut out the circular logo, produce an updated logo with an alpha channel, and create an icon pack" → scope=assets_only, inventLogo=false, wantsAssetEdit=true, assetOps=["make_transparent","circular_mask","derive_icon_pack"], targets=["logo"].
- "generate 7 different logos" / "7 logo ideas" / "make 5 circular marks in different styles" → inventLogo=true, inventLogoCount=that number (1–12). Multi means a concept grid, not a single pin.
- "pull/adopt theme or theming/design from a sibling / other registered project / absolute path" OR "using / mock with / design with <registered project or *-components>" → adoptTheme=true, set shareFrom to that name, targets include "palette" and usually "landing". Set preserveChrome=false — a new theme is an intentional redesign; do NOT preserve the prior mock's look unless asked.
- "look and feel" / "match the chrome" / "same menubar / theme-toggle / UserPill" from a sibling → adoptChrome=true AND adoptTheme=true, shareFrom set, targets include "shell","layout","palette". preserveChrome=false. Prefer the sibling theme-toggle element — do not invent a competing day/night control.
- "pull out / use the current theming" / "existing theming" / "existing design concepts" / "use the design pack" / "what we already have" (same project, no sibling named) → reuseProjectDesign=true, adoptTheme=false, omit shareFrom, targets include "palette". Set preserveChrome=false; ground the mock on the prior project design.
- Bare brand praise without adopt/from/using ("the sibling looks nice but tweak hero") → adoptTheme=false, do not set shareFrom.
- "align menu/nav with the code / what exists today" → navAlign=true (LIVE SITE label sync).
- "centre/center the menubar over page content" / "same width as the contents on the page" / "logo and menu left align, sign-in and theme right align" → targets include "shell" and "layout", navAlign=false, designScope={kind:"shell", focus:"menubar"}. This is chrome layout (applied_shell), not navAlign. Pure left/right slot layout without naming a sibling does NOT require adoptChrome.
- "I like the current look" / "keep the hero" / "do not change layout" → preserveChrome=true. "do not change hero" is NOT a request to change hero.
- scope picks the dominant intent: full_revise only for explicit redesign/start-over; nav_align for menu sync; assets_only when only media edits requested (never when inventLogo); logo_invent/adopt_theme when that dominates; otherwise sections. Fresh "create a landing + dashboard mock" without theme/reuse cues → full_revise or sections with landing+dashboard targets.
- When inventLogo, adoptTheme, adoptChrome, or reuseProjectDesign is true, prefer preserveChrome=false. Fingerprint drift must not veto an intentional theme/logo/chrome redesign.
- "only/just the chat form|composer|bubble" → designScope={kind:"component", focus:"chat.composer", preserve:["chrome","palette","logo","nav","shell"]}.
- "dark and light / theme toggle" without full redesign → designScope={kind:"shell", focus:"theme", preserve:["logo","content"]}.
`;

export interface ClassifyContinueIntentViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  brief?: string;
  /** When true, message is a fresh loop brief (not a continue). */
  isStart?: boolean;
  timeoutMs?: number;
}

/**
 * Classification-role JSON → validated ContinueIntent.
 * Success path: LLM JSON only + structured normalize (no regex merge).
 * Callers should catch and fall back to fallbackContinueIntentFromText.
 */
export async function classifyContinueIntentViaLlm(
  opts: ClassifyContinueIntentViaLlmOptions,
): Promise<ContinueIntent> {
  const kind = opts.isStart
    ? "Fresh design-loop start brief (classify this start):"
    : "Operator feedback on the current design mock (classify this continue):";
  const user = [
    kind,
    "",
    opts.message.slice(0, 4_000),
    !opts.isStart && opts.brief?.trim()
      ? `\nOriginal loop brief (context only):\n${opts.brief.trim().slice(0, 1_500)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: CONTINUE_INTENT_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  const raw =
    typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : {};
  // LLM-first: trust structured fields. Regex assetOps fill belongs only in
  // fallbackContinueIntentFromText after classify throws completely.
  const intent = ContinueIntentSchema.parse(raw);
  return normalizeContinueIntentStructured(intent);
}
