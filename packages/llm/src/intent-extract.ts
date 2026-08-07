import {
  ChangeIntentLlmOutputSchema,
  operatorRequestBody,
  type ChangeIntentLlmOutput,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const CHANGE_INTENT_SYSTEM_PROMPT = `You classify a software change request into a structured Change Intent JSON object.

Return ONLY a JSON object with these fields:
- title (string): short product-facing title — strip promote/status meta ("I want a task to promote…", "What phases are complete?")
- goal (string): 1–3 sentences describing the product work
- uiMount: "composer" | "bubble" | "modal" | "page" | "n/a"
- changeKind: "engagement" | "chrome-hide" | "backend" | "other"
- needsInteraction (boolean): true only when fill/submit (or equivalent) must be proven
- brandTheming (boolean): true when the ask is brand identity, palette, logo, wordmark, visual identity, or applying sibling theming/design that needs a design pass
- themeWiringOnly (boolean): true when the ask is only wiring a theme toggle / data-theme / light-dark switch with no new brand identity (coding only — not a design pass). Mutually exclusive with brandTheming.
- requestsMissingThemeControl (boolean): true when the operator says a menubar day/night or theme toggle is missing / not appearing / must be added or shown
- mustNot (optional string[]): extra constraints
- refinementOf (optional string or string[]): prior phase id hint if refining a mount

Classification rules:
- chrome-hide: hide empty form / tab strip / chrome when nothing to gather — no fill/submit contract. Set needsInteraction false. Prefer uiMount "composer".
- engagement: broken or missing fill/submit / populate / validate on forms at a mount. Set needsInteraction true.
- backend: non-UI / infrastructure / API-only (DB, migrations, env, servers). needsInteraction false; uiMount usually "n/a". Never brand/theming/logo.
- other: UI or product change that is neither chrome-hide nor engagement — INCLUDING brand, theming, logo, palette, design-system, look-and-feel, theme toggle / light-dark switch, landing-page chrome. Never classify brand/theming/logo as backend. Set needsInteraction false unless fill/submit is required.
- brandTheming=true for new logos, palettes, sibling theme adoption, visual identity. themeWiringOnly=true only for toggle/data-theme wiring without new identity (then brandTheming=false).
- Multilingual OK (Afrikaans, English, mixed).
- Do NOT invent needsInteraction=true for chrome-hide or backend.
- Do NOT set needsInteraction for non-form clicks (theme toggle, nav links, decorative controls) — clickable ≠ fill/submit form contract.
- Do NOT use status/roadmap questions or promote boilerplate ("generate a task to promote…") as the title — use the product work (e.g. "Port JamPress theming + cleaner logo").`;

export interface ExtractChangeIntentViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  description: string;
  /** Optional summary of a prior phase mount for refinement context. */
  priorMountSummary?: string;
  timeoutMs?: number;
}

/**
 * Planning-role JSON extract → validated ChangeIntentLlmOutput.
 * Caller should run finalizeChangeIntent on the result.
 */
export async function extractChangeIntentViaLlm(
  opts: ExtractChangeIntentViaLlmOptions,
): Promise<ChangeIntentLlmOutput> {
  const operatorBody = operatorRequestBody(opts.description);
  const userParts = [
    "Operator request (classify this; ignore ask-transcript noise outside this body):",
    "",
    operatorBody.slice(0, 6_000) || opts.description.slice(0, 6_000),
  ];
  if (opts.priorMountSummary?.trim()) {
    userParts.push(
      "",
      "Prior mount context (optional refinement):",
      opts.priorMountSummary.trim().slice(0, 1_000),
    );
  }

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: CHANGE_INTENT_SYSTEM_PROMPT,
    user: userParts.join("\n"),
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return ChangeIntentLlmOutputSchema.parse(parsed);
}
