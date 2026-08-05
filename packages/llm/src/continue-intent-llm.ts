import {
  ContinueIntentSchema,
  fallbackContinueIntentFromText,
  normalizeContinueIntent,
  type ContinueIntent,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const CONTINUE_INTENT_SYSTEM_PROMPT = `You classify a design-loop continue request (operator feedback on an existing mock) into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences, no apology, no "we are asking" narration — JSON object only.

Return ONLY a JSON object with these fields:
- scope: one of "assets_only" | "nav_align" | "logo_invent" | "adopt_theme" | "sections" | "full_revise"
- targets: string[] — subset of ["hero","copy","nav","logo","palette","tokens","typography","shell","layout","tasting-room","landing","dashboard","chat","settings","lockups"] the operator wants changed
- wantsAssetEdit: boolean — true when icon pack / alpha / transparency / resize image edits are requested
- inventLogo: boolean — true when the operator asks for a NEW logo/mark/symbol (invent or adopt a new asset)
- adoptTheme: boolean — true when the operator asks to pull palette/theme/branding from another project/sibling
- reuseProjectDesign: boolean — true when the operator asks to reuse THIS project's existing/current theming, design pack, or design concepts (not a named sibling)
- navAlign: boolean — true when the operator asks to align menus/nav with what exists in code
- preserveChrome: boolean — true when the operator explicitly says keep/do not change layout, hero, shell, copy, or nav
- notes: string — 1 sentence summary of what should change
- designScope: optional object to narrow/widen the conceptual model — { kind: "product"|"shell"|"screen"|"component"|"flow", focus: string, preserve?: string[] }. Omit when scope should stay unchanged. Use component+focus for "only the chat form/composer"; shell+focus "theme" for dark/light toggle work; product+focus "site" only for explicit whole-site redesign.

Rules:
- "new logo" / "symbolic mark" / "invent a mark" / "circular logo" / "replace the logos" / "different logo" / "I am unhappy with the logos" / "don't like the current logos" / "change the logo" → inventLogo=true, targets include "logo". Replacing the prior pinned logo is expected. Never assets_only for these. Set preserveChrome=false unless the operator explicitly says keep layout/hero/shell.
- "pull/adopt theme or theming/design from a sibling / other registered project / absolute path" → adoptTheme=true, targets include "palette" and usually "landing". Set preserveChrome=false — a new theme is an intentional redesign; do NOT preserve the prior mock's look unless asked.
- "pull out / use the current theming" / "existing theming" / "existing design concepts" / "use the design pack" / "what we already have" (same project, no sibling named) → reuseProjectDesign=true, adoptTheme=false, targets include "palette". Set preserveChrome=false; ground the mock on the prior project design.
- "align menu/nav with the code" → navAlign=true.
- "derive icon pack" / "make transparent" / "alpha" → wantsAssetEdit=true (only when NOT asking for a new/different logo).
- "I like the current look" / "keep the hero" / "do not change layout" → preserveChrome=true. "do not change hero" is NOT a request to change hero.
- scope picks the dominant intent: full_revise only for explicit redesign/start-over; nav_align for menu sync; assets_only when only media edits requested (never when inventLogo); logo_invent/adopt_theme when that dominates; otherwise sections.
- When inventLogo, adoptTheme, or reuseProjectDesign is true, prefer preserveChrome=false. Fingerprint drift must not veto an intentional theme/logo redesign.
- "only/just the chat form|composer|bubble" → designScope={kind:"component", focus:"chat.composer", preserve:["chrome","palette","logo","nav","shell"]}.
- "dark and light / theme toggle" without full redesign → designScope={kind:"shell", focus:"theme", preserve:["logo","content"]}.
`;

export interface ClassifyContinueIntentViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  brief?: string;
  timeoutMs?: number;
}

/**
 * Planning-role JSON classification → validated ContinueIntent.
 * Callers should catch and fall back to fallbackContinueIntentFromText.
 */
export async function classifyContinueIntentViaLlm(
  opts: ClassifyContinueIntentViaLlmOptions,
): Promise<ContinueIntent> {
  const user = [
    "Operator feedback on the current design mock (classify this continue):",
    "",
    opts.message.slice(0, 4_000),
    opts.brief?.trim()
      ? `\nOriginal loop brief (context only):\n${opts.brief.trim().slice(0, 1_500)}`
      : "",
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: CONTINUE_INTENT_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 15_000,
    temperature: 0,
  });

  const intent = ContinueIntentSchema.parse(parsed);
  const merged: ContinueIntent = {
    ...fallbackContinueIntentFromText(opts.message),
    ...intent,
    targets: intent.targets,
  };
  return normalizeContinueIntent(merged, opts.message);
}