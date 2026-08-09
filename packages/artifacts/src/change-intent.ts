import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { extractSection } from "./markdown.js";
import {
  bdVerifiedByProbes,
  type ProjectDecisionProbes,
} from "./blueprint-probes.js";

export type UiMount = "composer" | "bubble" | "modal" | "page" | "n/a";

export type ChangeKind = "engagement" | "chrome-hide" | "backend" | "other";

export type ChangeIntent = {
  title: string;
  goal: string;
  uiMount: UiMount;
  /** LLM/heuristic classification of the change (verification still keys off interaction). */
  changeKind?: ChangeKind;
  /**
   * Brand / palette / logo / identity work that needs a design pass.
   * Set by LLM (or offline heuristic); prefer over regex on description.
   */
  brandTheming?: boolean;
  /**
   * Theme toggle / data-theme wiring only — coding, not a design pass.
   * When true, overrides brandTheming for design-pass routing.
   */
  themeWiringOnly?: boolean;
  /**
   * Strip custom UI and adopt stock components/theming from the project's
   * component library (design-by-reference). When true, overrides
   * brandTheming — no generative design pass; the design already exists
   * in the library.
   */
  stockAdoption?: boolean;
  /**
   * Wire/swap/point at an EXISTING asset by filename (e.g. "use
   * jamlight-circular-mark-v1.png rather than the alpha logo"). No new
   * artwork is created — pure coding. Overrides brandTheming.
   */
  assetSwap?: boolean;
  /**
   * Operator asked to add/show a missing menubar theme control (anti-audit delivery).
   */
  requestsMissingThemeControl?: boolean;
  refinementOf: string[];
  supersedes: string[];
  mustNot: string[];
  rawDescription: string;
  /** When set, phase must prove fill/submit (or equivalent) at mount — not chip-only. */
  interaction?: InteractionContract;
};

/** Structured model output for Change Intent extraction (planning role). */
export const ChangeIntentLlmOutputSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  uiMount: z.enum(["composer", "bubble", "modal", "page", "n/a"]),
  changeKind: z.enum(["engagement", "chrome-hide", "backend", "other"]),
  needsInteraction: z.boolean(),
  brandTheming: z.boolean().optional(),
  themeWiringOnly: z.boolean().optional(),
  stockAdoption: z.boolean().optional(),
  assetSwap: z.boolean().optional(),
  requestsMissingThemeControl: z.boolean().optional(),
  mustNot: z.array(z.string()).optional(),
  /** Optional prior phase id hint(s) for mount refinement. */
  refinementOf: z.union([z.string(), z.array(z.string())]).optional(),
});

export type ChangeIntentLlmOutput = z.infer<typeof ChangeIntentLlmOutputSchema>;

/** Compact contract so engagement phases cannot “complete” on taxonomy-only work. */
export type InteractionContract = {
  mount: UiMount;
  primaryAction: string;
  proof: string[];
  forbiddenSubstitutes: string[];
};

const COMPOSER_RE =
  /\b(composer|chat\s*prompt|prompt\s*(?:window|area|box)|input\s*bar|text\s*area|bottom\s*(?:of\s*)?(?:the\s*)?chat)\b/i;
const BUBBLE_RE =
  /\b(speech\s*bubbles?|assistant\s*bubbles?|in[- ]bubbles?|chat\s*bubbles?|message\s*bubbles?)\b/i;
const MOVE_RE =
  /\b(move|relocate|put\s+(?:it|the\s+form)\s+in|switch\s+to|own\s+the\s+composer|from\s+the\s+bubble\s+to)\b/i;
const MODAL_RE = /\b(modal|dialog)\b/i;
const PAGE_RE = /\b(full[- ]?page|dedicated\s+page|new\s+route)\b/i;
/** Failure language: cannot fill / inert / superseded. */
const ENGAGEMENT_FAILURE_RE =
  /\b(unable\s+to\s+(?:input|fill|submit|edit|enter)|can'?t\s+(?:input|fill|submit|edit|enter)|not\s+active|inert|unsubmittable|not\s+(?:fillable|editable|submittable)|superseded\s+by|stuck\s+at\s+[\"']?superseded)\b/i;

/**
 * Capability language: operator wants populate / submit / validate on forms
 * (phase-56 style) even when they do not report a broken UI.
 */
const FORM_CAPABILITY_RE =
  /\b(?:populate|fill(?:able)?|submit(?:ted|s|ting)?|validat(?:e|ed|es|ion)|validate[- ]as[- ]you[- ]type|data[- ]gathering|dynamic\s+forms?)\b/i;

const FORM_CONTEXT_RE =
  /\b(?:forms?|form\s+bubble|skill|workflow|composer|params?\s+form)\b/i;

/** Promote / task-shaping preamble that must not become the Intent title. */
const META_PROMOTE_RE =
  /^(?:i\s+want\s+a\s+task\s+to\s+promote(?:\s+to\s+research)?|i\s+want\s+(?:you\s+to\s+)?promote(?:\s+this)?(?:\s+to\s+research)?|please\s+(?:can\s+you\s+)?(?:generate|create|make)\s+a\s+task(?:\s+to\s+promote)?(?:\s+to\s+research)?(?:\s+to\s+research)?|please\s+(?:can\s+you\s+)?give\s+me\s+a\s+task\s+for(?:\s+promotion)?(?:\s+to\s+research)?|promote\s+(?:this\s+)?(?:ask\s+)?(?:to\s+)?research|want\s+me\s+to\s+promote)[.!?]?\s*/i;

/** Status / roadmap questions that must not become the Intent title. */
const STATUS_META_RE =
  /^(?:what\s+phases?\s+(?:are\s+)?(?:complete|done|finished)\??|which\s+phases?\s+(?:are\s+)?(?:complete|done|finished)\??|show\s+me\s+(?:the\s+)?(?:roadmap|phase\s+status)|what(?:'?s|\s+is)\s+(?:the\s+)?(?:roadmap|phase\s+status|status)\??|how\s+many\s+phases?\s+(?:are\s+)?(?:complete|done)\??)[.!]?\s*/i;

/**
 * UX chrome asks: hide empty form / tab strip — lock composer mount, but do
 * not invent a fill/submit interaction contract.
 */
const CHROME_HIDE_RE =
  /\b(?:blank\s+form|empty\s+form|nothing\s+to\s+gather|hide\s+(?:the\s+)?tabs?|tabs?\s+(?:appear|disappear)|tab\s*strip|only\s+(?:display\s+)?(?:the\s+)?chat\s+(?:text\s+)?(?:area|window)|no\s+tab\s*strip|without\s+(?:the\s+)?tabs?)\b/i;

/** Brand / theming / logo asks — never classify as backend. */
const BRAND_THEMING_RE =
  /\b(?:them(?:e|ing)|brand(?:ing)?|logo|wordmark|favicon|palette|design\s+system|look\s+and\s+feel|visual\s+identity|re-?brand)\b/i;

/** Common typo: "new log" meaning "new logo". */
const LOGO_TYPO_RE = /\bnew\s+logs?\b/i;

/**
 * Stock / component-library adoption: strip custom UI in favor of the shared
 * library's stock widgets (design-by-reference — no generative design pass).
 */
const STOCK_ADOPTION_RE =
  /\b(?:stock\s+(?:[\w-]+\s+){0,3}(?:component|widget|menubar|theme|theming|ui)|component\s+library|from\s+(?:the\s+)?[\w@/-]*components(?:\s+project)?\b|[\w@/-]*components\s+project|jamroast-components)\b/i;
const STOCK_ADOPTION_VERB_RE =
  /\b(?:strip|replace|adopt|use|switch\s+to|reset\s+to|standardi[sz]e\s+on|pull\s+in)\b/i;

/**
 * Offline/heuristic: strip-and-adopt stock component-library UI.
 * Prefer the LLM `stockAdoption` field when INTENT.json exists.
 */
export function isStockAdoptionAsk(description: string): boolean {
  const text = description ?? "";
  return STOCK_ADOPTION_RE.test(text) && STOCK_ADOPTION_VERB_RE.test(text);
}

/**
 * Asset-swap language: the ask references an existing asset by filename and
 * wants it mounted/swapped/pointed at — no new artwork is requested.
 */
const ASSET_FILENAME_RE = /\b[\w][\w-]*\.(?:png|svg|webp|jpe?g|ico)\b/i;
const ASSET_SWAP_VERB_RE =
  /\b(?:use|swap|rather\s+than|instead\s+of|replace|mount|point|wire|reference|switch\s+to|show|display)\b/i;
const ASSET_CREATION_RE =
  /\b(?:new\s+(?:logo|icon|mark|wordmark)|generate|design\s+a|create\s+a\s+(?:new\s+)?(?:logo|icon)|redesign|re-?brand)\b/i;

/**
 * Offline/heuristic: wire/swap an EXISTING asset by filename — pure coding.
 * Prefer the LLM `assetSwap` field when INTENT.json exists.
 */
export function isAssetSwapAsk(description: string): boolean {
  const text = description ?? "";
  if (ASSET_CREATION_RE.test(text)) return false;
  return ASSET_FILENAME_RE.test(text) && ASSET_SWAP_VERB_RE.test(text);
}

/**
 * Offline/heuristic: brand, theming, logo, or palette ask.
 * Prefer changeIntentIsBrandTheming when INTENT.json exists.
 */
export function isBrandThemingAsk(description: string): boolean {
  const text = description ?? "";
  if (isStockAdoptionAsk(text)) return false;
  if (isAssetSwapAsk(text)) return false;
  return BRAND_THEMING_RE.test(text) || LOGO_TYPO_RE.test(text);
}

/**
 * Structured brand-theming gate (LLM flags; legacy Intent falls back to heuristic).
 */
export function changeIntentIsBrandTheming(intent: ChangeIntent): boolean {
  if (intent.themeWiringOnly === true) return false;
  if (intent.stockAdoption === true) return false;
  if (intent.assetSwap === true) return false;
  if (typeof intent.brandTheming === "boolean") return intent.brandTheming;
  const text = `${intent.title}\n${intent.goal}\n${intent.rawDescription}`;
  return isBrandThemingAsk(text) && !isThemeWiringAsk(text);
}

/**
 * Structured theme-wiring-only gate (LLM flags; legacy falls back to heuristic).
 */
export function changeIntentIsThemeWiringOnly(intent: ChangeIntent): boolean {
  if (typeof intent.themeWiringOnly === "boolean") return intent.themeWiringOnly;
  if (intent.brandTheming === true) return false;
  const text = `${intent.title}\n${intent.goal}\n${intent.rawDescription}`;
  return isThemeWiringAsk(text);
}

/**
 * Theme toggle / data-theme / light-dark wiring without new brand identity.
 * Offline heuristic only — prefer changeIntentIsThemeWiringOnly.
 */
export function isThemeWiringAsk(description: string): boolean {
  const text = description ?? "";
  if (
    !/\b(?:theme\s*toggle|light\s*[\/&-]?\s*dark|dark\s*[\/&-]?\s*light|data-theme|useTheme|prefers-color-scheme|color-scheme)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  // New brand identity / port sibling theming still needs design.
  if (
    /\b(?:logo|wordmark|favicon|re-?brand|visual\s+identity|new\s+palette|apply\s+(?:the\s+)?theming|port\s+(?:the\s+)?them|design\s+system)\b/i.test(
      text,
    ) || LOGO_TYPO_RE.test(text)
  ) {
    return false;
  }
  return true;
}

/** Brand/Assets section body that explicitly opts out of visual design work. */
export function isNotApplicableDesignSection(section: string): boolean {
  const t = (section ?? "").trim();
  if (!t) return true;
  const firstLine = t.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  return /^(?:not\s+applicable|n\/?a\b|none\b|no\s+(?:new\s+)?(?:brand|assets|visual)|this\s+phase\s+does\s+not)/i.test(
    firstLine,
  );
}

const LIVE_DECISIONS_HEADING = "## Live decisions";
const LIVE_VERIFIED_HEADING = "## Live decisions — verified";
const LIVE_CLAIMED_HEADING = "## Live decisions — claimed unverified";

/**
 * Heuristic Change Intent from a phase description (no LLM required).
 * Prefer calling this at promote_ask / start_research and storing the result.
 */
/** Prefer the operator-request section when promote_ask wraps ask noise. */
export function operatorRequestBody(raw: string): string {
  const m = raw.match(
    /##\s*Operator request\s*\n+([\s\S]*?)(?=\n##\s|\n###\s|$)/i,
  );
  return (m?.[1] ?? raw).trim();
}

/** Strip leading promote/status meta so title/goal describe the product work. */
export function stripMetaPromotePreamble(text: string): string {
  let t = (text ?? "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 6; i++) {
    let next = t.replace(META_PROMOTE_RE, "").trim();
    next = next.replace(STATUS_META_RE, "").trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * True when the ask is primarily about hiding empty form chrome / tabs
 * (phase-57 style), not fixing broken fill/submit.
 */
export function isChromeHideAsk(description: string): boolean {
  return CHROME_HIDE_RE.test(description ?? "");
}

function firstSentenceOrClause(text: string, maxLen: number): string {
  let cleaned = stripMetaPromotePreamble(text.replace(/\s+/g, " ").trim());
  if (!cleaned) return "Untitled change";
  // Skip additional leading status/meta sentences if stripping left mid-clause noise
  for (let i = 0; i < 3; i++) {
    const sentence = cleaned.match(/^(.{1,500}?[.!?])(?:\s|$)/);
    if (!sentence?.[1]) break;
    const candidate = sentence[1].trim();
    const rest = cleaned.slice(sentence[0].length).trim();
    if (
      STATUS_META_RE.test(`${candidate} `) ||
      META_PROMOTE_RE.test(`${candidate} `)
    ) {
      cleaned = stripMetaPromotePreamble(rest);
      continue;
    }
    if (candidate.length <= maxLen) return candidate;
    const slice = candidate.slice(0, maxLen);
    const sp = slice.lastIndexOf(" ");
    return (sp > maxLen * 0.6 ? slice.slice(0, sp) : slice).trim();
  }
  if (!cleaned) return "Untitled change";
  const sentence = cleaned.match(/^(.{1,500}?[.!?])(?:\s|$)/);
  const candidate = (sentence?.[1] ?? cleaned).trim();
  if (candidate.length <= maxLen) return candidate;
  const slice = candidate.slice(0, maxLen);
  const sp = slice.lastIndexOf(" ");
  return (sp > maxLen * 0.6 ? slice.slice(0, sp) : slice).trim();
}

/** Full paragraph clipped at a word boundary (for goals — not first-sentence only). */
function clipAtWord(text: string, maxLen: number): string {
  let cleaned = stripMetaPromotePreamble(text.replace(/\s+/g, " ").trim());
  // Drop trailing promote asks that truncate awkwardly
  cleaned = cleaned
    .replace(
      /\s*please\s+(?:can\s+you\s+)?give\s+me\s+a\s+task\s+for(?:\s+promotion)?(?:\s+to\s+research)?[.!?]?\s*$/i,
      "",
    )
    .trim();
  if (!cleaned) return "Untitled change";
  if (cleaned.length <= maxLen) return cleaned;
  const slice = cleaned.slice(0, maxLen);
  const sp = slice.lastIndexOf(" ");
  return (sp > maxLen * 0.6 ? slice.slice(0, sp) : slice).trim();
}

/** True when the ask needs a fill/submit interaction contract. */
export function needsInteractionContract(description: string): boolean {
  const text = description ?? "";
  if (ENGAGEMENT_FAILURE_RE.test(text)) return true;
  // Hide-empty-form / tab-strip UX: composer mount yes, fill/submit contract no
  if (isChromeHideAsk(text)) return false;
  // Capability ask only when it is clearly about forms / skills / workflows.
  return FORM_CAPABILITY_RE.test(text) && FORM_CONTEXT_RE.test(text);
}

export function isEngagementSymptom(description: string): boolean {
  return needsInteractionContract(description);
}

function defaultInteractionContract(uiMount: UiMount): InteractionContract | undefined {
  if (uiMount === "n/a") return undefined;
  const proof =
    uiMount === "composer"
      ? ["data-testid=composer-form", "enabled input or textarea", "submit control"]
      : uiMount === "bubble"
        ? ["actionable FormBubble in transcript", "enabled input", "submit control"]
        : ["interactive control at locked mount", "primary action reachable"];
  return {
    mount: uiMount,
    primaryAction: "submit form",
    proof,
    forbiddenSubstitutes: [
      "summary-chip-only",
      "taxonomy-only classification fix without actionable mount",
      "manual smoke not the gate",
    ],
  };
}

function applyMountSideEffects(uiMount: UiMount): {
  mustNot: string[];
  supersedes: string[];
} {
  const mustNot: string[] = [];
  const supersedes: string[] = [];
  if (uiMount === "composer") {
    mustNot.push(
      "do not move the interactive form back into the assistant speech bubble only",
    );
    mustNot.push(
      "do not supersede composer form mode with in-bubble-only forms",
    );
    mustNot.push(
      "do not replace the fillable composer form with transcript chips/summaries only",
    );
    supersedes.push("BD-IN-BUBBLE-FORMS");
  }
  if (uiMount === "bubble") {
    mustNot.push("do not mount the interactive form only in the composer");
    supersedes.push("BD-COMPOSER-FORM-MODE");
  }
  return { mustNot, supersedes };
}

/** Find nearest prior phase INTENT with a concrete uiMount. */
export function findPriorUiMountIntent(
  projectRoot: string,
  excludePhaseId?: string,
): { phaseId: string; intent: ChangeIntent } | null {
  const phasesDir = join(projectRoot, ".slopcontrol", "phases");
  if (!existsSync(phasesDir)) return null;
  let names: string[] = [];
  try {
    names = readdirSync(phasesDir)
      .filter((n) => !n.startsWith("."))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const id of names) {
    if (excludePhaseId && id === excludePhaseId) continue;
    const intent = readChangeIntent(projectRoot, id);
    if (intent && intent.uiMount !== "n/a") {
      return { phaseId: id, intent };
    }
  }
  return null;
}

function inferUiMountFromText(raw: string): UiMount {
  const wantsMove = MOVE_RE.test(raw);
  if (
    COMPOSER_RE.test(raw) &&
    (wantsMove || !BUBBLE_RE.test(raw) || /chat\s*prompt/i.test(raw))
  ) {
    return "composer";
  }
  if (BUBBLE_RE.test(raw) && !COMPOSER_RE.test(raw)) {
    return "bubble";
  }
  if (MODAL_RE.test(raw) && wantsMove) return "modal";
  if (PAGE_RE.test(raw) && wantsMove) return "page";
  if (COMPOSER_RE.test(raw)) return "composer";
  if (BUBBLE_RE.test(raw)) return "bubble";
  return "n/a";
}

function normalizeRefinementOf(
  hint: string | string[] | undefined,
): string[] {
  if (!hint) return [];
  if (typeof hint === "string") {
    const t = hint.trim();
    return t ? [t] : [];
  }
  return hint.map((s) => s.trim()).filter(Boolean);
}

/**
 * Deterministic post-process for LLM or heuristic Intent fields.
 * Clips lengths, applies mount side effects, and sets interaction from
 * structured changeKind / needsInteraction (no description regex veto).
 */
export function finalizeChangeIntent(
  raw: ChangeIntentLlmOutput,
  opts: {
    description: string;
    projectRoot?: string;
    phaseId?: string;
  },
): ChangeIntent {
  const description = (opts.description ?? "").trim();
  let uiMount = raw.uiMount;
  let refinementOf = normalizeRefinementOf(raw.refinementOf);

  const changeKind = raw.changeKind;
  const allowInteraction =
    changeKind !== "chrome-hide" &&
    changeKind !== "backend" &&
    (changeKind === "engagement" || Boolean(raw.needsInteraction));

  const resolvePriorMount = (): void => {
    if (!opts.projectRoot || refinementOf.length > 0) return;
    const prior = findPriorUiMountIntent(opts.projectRoot, opts.phaseId);
    if (prior) {
      uiMount = prior.intent.uiMount;
      refinementOf = [prior.phaseId];
    }
  };

  if (allowInteraction) {
    if (opts.projectRoot) {
      if (refinementOf.length === 0) {
        const prior = findPriorUiMountIntent(opts.projectRoot, opts.phaseId);
        if (prior) {
          uiMount = prior.intent.uiMount;
          refinementOf = [prior.phaseId];
        } else if (uiMount === "n/a") {
          uiMount = "composer";
        } else if (uiMount === "bubble") {
          uiMount = "composer";
        }
      }
    } else if (uiMount === "n/a") {
      uiMount = "composer";
    }
  } else if (changeKind === "chrome-hide") {
    resolvePriorMount();
    if (uiMount === "n/a") uiMount = "composer";
    if (uiMount === "bubble") uiMount = "composer";
  }

  const { mustNot, supersedes } = applyMountSideEffects(uiMount);
  if (allowInteraction) {
    mustNot.push(
      "do not treat summary chips or classification-only changes as satisfying fill/submit",
    );
  }
  if (raw.mustNot?.length) {
    for (const m of raw.mustNot) {
      const t = m.trim();
      if (t && !mustNot.includes(t)) mustNot.push(t);
    }
  }

  const title = firstSentenceOrClause(raw.title, 120);
  const goal = clipAtWord(raw.goal, 800);
  const interaction = allowInteraction
    ? defaultInteractionContract(uiMount === "n/a" ? "composer" : uiMount)
    : undefined;

  const themeWiringOnly = Boolean(raw.themeWiringOnly);
  const stockAdoption = Boolean(raw.stockAdoption);
  const assetSwap = Boolean(raw.assetSwap);
  const brandTheming =
    themeWiringOnly || stockAdoption || assetSwap
      ? false
      : Boolean(raw.brandTheming);

  return {
    title,
    goal,
    uiMount,
    changeKind,
    brandTheming,
    themeWiringOnly,
    stockAdoption,
    assetSwap,
    requestsMissingThemeControl: Boolean(raw.requestsMissingThemeControl),
    refinementOf,
    supersedes,
    mustNot,
    rawDescription: description,
    interaction,
  };
}

/**
 * Heuristic Change Intent from a phase description (no LLM required).
 * Used as sync fallback when the planning LLM is unavailable.
 */
export function extractChangeIntent(
  description: string,
  opts?: { projectRoot?: string; phaseId?: string },
): ChangeIntent {
  const raw = (description ?? "").trim();
  const operatorBody = operatorRequestBody(raw);
  const heuristicText = operatorBody || raw;
  const failureEngagement = ENGAGEMENT_FAILURE_RE.test(heuristicText);
  const chromeOnly = isChromeHideAsk(heuristicText) && !failureEngagement;
  const wantsIx = needsInteractionContract(heuristicText);

  const titleSource =
    stripMetaPromotePreamble(
      operatorBody
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith(">"))
        .join(" "),
    ) || "Untitled change";
  let title = firstSentenceOrClause(titleSource, 120);
  if (chromeOnly) {
    const problem = titleSource.match(
      /([^.!?]*(?:blank\s+form|empty\s+form|nothing\s+to\s+gather|not\s+to\s+display\s+the\s+tabs|tab\s*strip|only\s+display\s+the\s+chat)[^.!?]*[.!?])/i,
    );
    if (problem?.[1]) {
      title = firstSentenceOrClause(problem[1].trim(), 120);
    }
  }

  let uiMount = inferUiMountFromText(heuristicText);
  let refinementOf: string[] = [];

  if (wantsIx) {
    if (opts?.projectRoot) {
      const prior = findPriorUiMountIntent(opts.projectRoot, opts.phaseId);
      if (prior) {
        uiMount = prior.intent.uiMount;
        refinementOf = [prior.phaseId];
      } else if (uiMount === "n/a") {
        uiMount = "composer";
      } else if (failureEngagement && uiMount === "bubble") {
        uiMount = "composer";
      }
    } else if (uiMount === "n/a") {
      uiMount = "composer";
    } else if (failureEngagement && uiMount === "bubble") {
      uiMount = "composer";
    }
  } else if (chromeOnly) {
    if (opts?.projectRoot) {
      const prior = findPriorUiMountIntent(opts.projectRoot, opts.phaseId);
      if (prior) {
        uiMount = prior.intent.uiMount;
        refinementOf = [prior.phaseId];
      } else if (uiMount === "n/a") {
        uiMount = "composer";
      }
    } else if (uiMount === "n/a") {
      uiMount = "composer";
    }
    if (uiMount === "bubble") uiMount = "composer";
  }

  const goalParagraph =
    operatorBody
      .split(/\n\n+/)
      .map((p) => p.trim())
      .find(
        (p) =>
          p.length > 40 &&
          !p.startsWith("```") &&
          !/^###?\s*Proposed approach/i.test(p) &&
          !/^###?\s*Ask conversation/i.test(p) &&
          !STATUS_META_RE.test(`${p.replace(/\s+/g, " ").trim()} `),
      ) ?? operatorBody;

  const goal = clipAtWord(
    goalParagraph.replace(/^>\s*/gm, "").trim(),
    800,
  );

  const themeWiringOnly = isThemeWiringAsk(heuristicText);
  const stockAdoption = isStockAdoptionAsk(heuristicText);
  const assetSwap = isAssetSwapAsk(heuristicText);
  const brandTheming =
    !stockAdoption &&
    !assetSwap &&
    !themeWiringOnly &&
    isBrandThemingAsk(heuristicText);
  const changeKind: ChangeKind = chromeOnly
    ? "chrome-hide"
    : wantsIx
      ? "engagement"
      : brandTheming || themeWiringOnly
        ? "other"
        : uiMount === "n/a"
          ? "backend"
          : "other";

  return finalizeChangeIntent(
    {
      title,
      goal,
      uiMount,
      changeKind,
      needsInteraction: wantsIx,
      brandTheming,
      themeWiringOnly,
      stockAdoption,
      assetSwap,
      requestsMissingThemeControl: false,
      refinementOf,
    },
    { description: raw, projectRoot: opts?.projectRoot, phaseId: opts?.phaseId },
  );
}

export function formatChangeIntentPromptBlock(intent: ChangeIntent): string {
  const interactionLines = intent.interaction
    ? [
        `- **interaction.mount:** ${intent.interaction.mount}`,
        `- **interaction.primaryAction:** ${intent.interaction.primaryAction}`,
        `- **interaction.proof:** ${intent.interaction.proof.join("; ")}`,
        `- **interaction.forbiddenSubstitutes:** ${intent.interaction.forbiddenSubstitutes
          .map((s) => `"${s}"`)
          .join("; ")}`,
      ]
    : [];
  return [
    "## Change Intent (authoritative — obey over older Blueprint Deltas)",
    "",
    `- **title:** ${intent.title}`,
    `- **goal:** ${intent.goal}`,
    `- **uiMount:** ${intent.uiMount}`,
    intent.changeKind ? `- **changeKind:** ${intent.changeKind}` : null,
    intent.brandTheming ? `- **brandTheming:** true` : null,
    intent.themeWiringOnly ? `- **themeWiringOnly:** true` : null,
    intent.stockAdoption
      ? `- **stockAdoption:** true (design-by-reference — no generative design pass)`
      : null,
    intent.assetSwap
      ? `- **assetSwap:** true (wire/swap an existing asset — no generative design pass)`
      : null,
    intent.requestsMissingThemeControl
      ? `- **requestsMissingThemeControl:** true`
      : null,
    intent.refinementOf.length
      ? `- **refinementOf:** ${intent.refinementOf.join(", ")}`
      : null,
    intent.supersedes.length
      ? `- **supersedes:** ${intent.supersedes.join(", ")}`
      : null,
    intent.mustNot.length
      ? `- **mustNot:** ${intent.mustNot.map((m) => `"${m}"`).join("; ")}`
      : null,
    ...interactionLines,
    "",
    "Operator-refinement rules:",
    "- If uiMount is composer/bubble/modal/page, Scope and Blueprint Deltas MUST place the interactive UI there.",
    "- Do NOT \"restore prior UX\" or supersede a mount BD unless Change Intent explicitly asks to restore.",
    "- Broken engagement at the new mount → fix that mount; do not revert placement.",
    "- Refinement of an existing form → remount/reuse components; do not invent a parallel feature as a substitute.",
    "- Engagement goals require an Automated Check that proves the actionable surface (not chip-only / manual-smoke-optional).",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function changeIntentPath(projectRoot: string, phaseId: string): string {
  return join(projectRoot, ".slopcontrol", "phases", phaseId, "INTENT.json");
}

export function writeChangeIntent(
  projectRoot: string,
  phaseId: string,
  intent: ChangeIntent,
): string {
  const dir = join(projectRoot, ".slopcontrol", "phases", phaseId);
  mkdirSync(dir, { recursive: true });
  const path = changeIntentPath(projectRoot, phaseId);
  writeFileSync(path, `${JSON.stringify(intent, null, 2)}\n`, "utf-8");
  return path;
}

export function readChangeIntent(
  projectRoot: string,
  phaseId: string,
): ChangeIntent | null {
  const path = changeIntentPath(projectRoot, phaseId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ChangeIntent;
  } catch {
    return null;
  }
}

/** True when on-disk Intent should be refreshed for this description. */
export function isChangeIntentWeak(
  existing: ChangeIntent,
  description: string,
): boolean {
  const op =
    description.match(
      /##\s*Operator request\s*\n+([\s\S]*?)(?=\n##\s|\n###\s|$)/i,
    )?.[1] ?? description;
  const needsIx = needsInteractionContract(op);
  const chromeOnly =
    isChromeHideAsk(op) && !ENGAGEMENT_FAILURE_RE.test(op);
  const brandAsk = isBrandThemingAsk(op);
  const stockAdoptMisclassed =
    isStockAdoptionAsk(op) &&
    existing.stockAdoption !== true &&
    existing.brandTheming === true;
  const assetSwapMisclassed =
    isAssetSwapAsk(op) &&
    existing.assetSwap !== true &&
    existing.brandTheming === true;
  const weakMustNot =
    needsIx &&
    (existing.uiMount === "composer" || existing.uiMount === "n/a") &&
    existing.mustNot.length === 0;
  const weakTitle =
    (chromeOnly && /what\s+phases?\s+(?:are\s+)?complete/i.test(existing.title)) ||
    (brandAsk &&
      /(?:promote\s+to\s+research|for\s+me\s+to\s+promote|^untitled)/i.test(
        existing.title,
      ));
  const spuriousInteraction =
    Boolean(existing.interaction) &&
    !needsIx &&
    existing.changeKind !== "engagement";
  return (
    !existing.changeKind ||
    (existing.uiMount === "n/a" && (needsIx || chromeOnly)) ||
    (needsIx && !existing.interaction) ||
    (chromeOnly && Boolean(existing.interaction)) ||
    (chromeOnly && existing.changeKind !== "chrome-hide") ||
    (brandAsk && existing.changeKind === "backend") ||
    stockAdoptMisclassed ||
    assetSwapMisclassed ||
    spuriousInteraction ||
    weakMustNot ||
    weakTitle
  );
}

/**
 * Ensure INTENT.json exists. Weak write-once intents are refreshed when the
 * description needs an interaction contract but the stored Intent is incomplete.
 * Sync / heuristic-only — prefer ensureChangeIntentAsync when a registry exists.
 */
export function ensureChangeIntent(
  projectRoot: string,
  phaseId: string,
  description: string,
): ChangeIntent {
  const existing = readChangeIntent(projectRoot, phaseId);
  if (existing && !isChangeIntentWeak(existing, description)) {
    return existing;
  }
  const intent = extractChangeIntent(description, { projectRoot, phaseId });
  writeChangeIntent(projectRoot, phaseId, intent);
  return intent;
}

/** Build adjacent-phase context for research (titles + BD one-liners + handoff knowledge). */
export function buildAdjacentPhaseContextPack(
  projectRoot: string,
  limit = 5,
): string {
  const phasesDir = join(projectRoot, ".slopcontrol", "phases");
  if (!existsSync(phasesDir)) return "";
  let names: string[] = [];
  try {
    names = readdirSync(phasesDir)
      .filter((n) => !n.startsWith("."))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return "";
  }
  const blocks: string[] = [
    "## Prior phases (override only if Change Intent says so)",
    "",
  ];

  // Prefer live decisions from BLUEPRINT when present (verified + claimed).
  const bpPath = join(projectRoot, ".slopcontrol", "BLUEPRINT.md");
  if (existsSync(bpPath)) {
    try {
      const live = extractLiveDecisions(readFileSync(bpPath, "utf-8"));
      if (live.trim()) {
        blocks.push(
          "### Live decisions (from BLUEPRINT — authoritative)",
          live.trim(),
          "",
        );
      }
    } catch {
      /* ignore */
    }
  }

  for (const id of names) {
    const phaseMd = join(phasesDir, id, "PHASE.md");
    const appendix = join(phasesDir, id, "APPENDIX.md");
    const statusPath = join(phasesDir, id, "status.json");
    let status = "?";
    if (existsSync(statusPath)) {
      try {
        status = String(
          (JSON.parse(readFileSync(statusPath, "utf-8")) as { status?: string })
            .status ?? "?",
        );
      } catch {
        /* ignore */
      }
    }
    let title = id;
    let deltas = "";
    if (existsSync(phaseMd)) {
      const body = readFileSync(phaseMd, "utf-8");
      const h1 = body.match(/^#\s+(.+)$/m);
      if (h1?.[1]) title = h1[1].trim().slice(0, 120);
      const d = extractSection(body, /Blueprint\s+Deltas?/i);
      if (d?.trim()) {
        deltas = d
          .trim()
          .split("\n")
          .filter((l) => !/~~/.test(l))
          .slice(0, 8)
          .join("\n");
      }
    }
    let knowledge = "";
    if (existsSync(appendix)) {
      const app = readFileSync(appendix, "utf-8");
      const kn =
        extractSection(app, /Knowledge/i) ??
        extractSection(app, /Operator\s+handoff/i);
      if (kn?.trim()) {
        knowledge = kn.trim().slice(0, 600);
      }
    }
    blocks.push(`### ${id} (status=${status})`);
    blocks.push(title);
    if (deltas) {
      blocks.push("", "Blueprint Deltas (excerpt):", deltas);
    }
    if (knowledge) {
      blocks.push("", "Handoff/Knowledge (excerpt):", knowledge);
    }
    blocks.push("");
  }
  return blocks.join("\n");
}

/**
 * Fail when PHASE Blueprint Deltas reverse the Change Intent uiMount,
 * or when engagement intents only change chip taxonomy.
 */
export function phaseDocAlignsWithChangeIntent(
  phaseDoc: string,
  intent: ChangeIntent,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const deltas =
    extractSection(phaseDoc, /Blueprint\s+Deltas?/i)?.toLowerCase() ?? "";
  const scope = extractSection(phaseDoc, /Scope/i)?.toLowerCase() ?? "";
  const checks =
    extractSection(phaseDoc, /Automated\s+Checks?/i)?.toLowerCase() ?? "";
  const success =
    extractSection(phaseDoc, /Success\s+Criteria/i)?.toLowerCase() ?? "";
  const body = `${deltas}\n${scope}`;

  if (intent.uiMount === "composer") {
    if (
      /bd-in-bubble-forms|mounts?\s+\*\*inside the assistant|not in the composer|composer surface is always `?chatinput/i.test(
        body,
      ) &&
      !/bd-composer-form-mode|composer-form|forms?\s+own\s+the\s+composer/i.test(
        body,
      )
    ) {
      issues.push(
        "Change Intent uiMount=composer but PHASE Blueprint Deltas / Scope lock forms into the assistant bubble (BD-IN-BUBBLE-FORMS style)",
      );
    }
    if (
      /supersedes?\s+the\s+phase-?\d*\s*composer|supersedes?\s+.*composer-mount/i.test(
        body,
      )
    ) {
      issues.push(
        "PHASE supersedes composer mount while Change Intent requires uiMount=composer",
      );
    }
  }
  if (intent.uiMount === "bubble") {
    if (
      /bd-composer-form-mode|composer-form|forms?\s+own\s+the\s+composer/i.test(
        body,
      ) &&
      !/bd-in-bubble-forms|inside the assistant speech bubble/i.test(body)
    ) {
      issues.push(
        "Change Intent uiMount=bubble but PHASE locks forms into the composer",
      );
    }
  }

  if (intent.interaction && intent.interaction.mount !== "n/a") {
    const engagementBody = `${scope}\n${success}\n${checks}\n${deltas}`;
    const chipOnly =
      /summary\s*chip|transcript.*chip|classification|getformpartstate|superseded.*chip/i.test(
        engagementBody,
      ) &&
      !/composer-form|actionable|fillable|submittable|data-testid=["']composer-form|enabled\s+input|submit/i.test(
        engagementBody,
      );
    if (chipOnly) {
      issues.push(
        "Change Intent interaction contract requires an actionable mount proof; chip/taxonomy-only PHASE is not enough",
      );
    }
    const hasProofHint =
      /composer-form|data-testid|playwright|fill|submit|actionable|enabled/i.test(
        `${checks}\n${success}`,
      );
    if (!hasProofHint) {
      issues.push(
        "Engagement Change Intent requires Automated Checks / Success Criteria that prove fill+submit at the locked mount",
      );
    }
    // Live AI SDK static tool parts encode the name in type: "tool-<name>" —
    // fixtures that only use tool-invocation + toolName miss the live break.
    const proofSurface = `${checks}\n${success}`;
    const hasLiveShapeProof =
      /tool-<|live\s+static|parseToolResult|extractActiveForm|no\s+toolName|without\s+toolName|derive.*(?:tool\s*)?name|toolName.*from\s+type|slice\(["']tool-/i.test(
        proofSurface,
      ) ||
      (/type\s*[:=]\s*["'`]tool-(?!invocation)/i.test(proofSurface) &&
        !/tool-invocation/i.test(proofSurface));
    if (!hasLiveShapeProof) {
      issues.push(
        "Engagement Change Intent requires Automated Checks / Success Criteria that prove live AI SDK static tool-part name resolution (type: tool-<name> / parseToolResult / extractActiveForm) — not only tool-invocation + toolName fixtures",
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Remove superseded mount BDs when merging a new opposite mount BD.
 * When `intent` is provided, never strike the INTENT winner's mount family.
 */
export function garbageCollectSupersededMountBds(
  blueprint: string,
  intent?: ChangeIntent | null,
): string {
  let next = blueprint;
  const preferComposer = intent?.uiMount === "composer";
  const preferBubble = intent?.uiMount === "bubble";

  if (preferComposer) {
    next = next.replace(
      /^([-*]\s+)\*\*BD-IN-BUBBLE-FORMS[^*]*\*\*/gim,
      "$1~~**BD-IN-BUBBLE-FORMS**~~ _(superseded)_",
    );
    // Unstrike composer family if previously struck incorrectly
    next = next.replace(
      /^([-*]\s+)~~\*\*BD-COMPOSER-FORM-MODE(?:-RESTORED)?\*\*~~[^\n]*/gim,
      "$1**BD-COMPOSER-FORM-MODE:** forms in composer (restored — Change Intent).",
    );
    return next;
  }

  if (preferBubble) {
    next = next.replace(
      /^([-*]\s+)\*\*BD-COMPOSER-FORM-MODE:?\*\*/gim,
      "$1~~**BD-COMPOSER-FORM-MODE**~~ _(superseded)_",
    );
    next = next.replace(
      /^([-*]\s+)\*\*BD-COMPOSER-FORM-MODE-RESTORED[^*]*\*\*/gim,
      "$1~~**BD-COMPOSER-FORM-MODE-RESTORED**~~ _(superseded)_",
    );
    return next;
  }

  // Legacy intent-blind behaviour (no INTENT): later composer wins over bubble.
  if (
    /BD-IN-BUBBLE-FORMS/i.test(next) &&
    /supersedes/i.test(next) &&
    /BD-COMPOSER-FORM-MODE/i.test(next)
  ) {
    const lastComposer = next.lastIndexOf("BD-COMPOSER-FORM-MODE");
    const lastBubble = next.lastIndexOf("BD-IN-BUBBLE-FORMS");
    if (lastBubble > lastComposer) {
      next = next.replace(
        /^([-*]\s+)\*\*BD-COMPOSER-FORM-MODE:?\*\*/gim,
        "$1~~**BD-COMPOSER-FORM-MODE**~~ _(superseded)_",
      );
    }
  }
  const lastComposer = next.lastIndexOf("BD-COMPOSER-FORM-MODE");
  const lastBubble = next.lastIndexOf("BD-IN-BUBBLE-FORMS");
  if (
    lastComposer > lastBubble &&
    lastBubble >= 0 &&
    /BD-IN-BUBBLE-FORMS/i.test(next)
  ) {
    next = next.replace(
      /^([-*]\s+)\*\*BD-IN-BUBBLE-FORMS[^*]*\*\*/gim,
      "$1~~**BD-IN-BUBBLE-FORMS**~~ _(superseded)_",
    );
  }
  return next;
}

const BD_BULLET_RE =
  /^([-*]\s+)(?:~~)?\*\*(BD-[A-Z0-9-]+)(?:[^*]|\*(?!\*))*\*\*(?:~~)?([^\n]*)$/gim;

type BdHit = {
  id: string;
  line: string;
  struck: boolean;
  index: number;
  fullMatch: string;
};

function collectBdHits(blueprint: string): BdHit[] {
  const hits: BdHit[] = [];
  // Match both "- **BD-FOO:** …" and "- **BD-FOO (desc):** …" and struck variants.
  const re =
    /^([-*]\s+)(?:~~)?\*\*(BD-[A-Z0-9-]+)(?:\s*\([^)]*\))?:?\*\*(?:~~)?([^\n]*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blueprint)) !== null) {
    const id = m[2] ?? "";
    const struck =
      /~~/.test(m[0]) ||
      /_\(superseded\)_/i.test(m[0]) ||
      /_\(duplicate\)_/i.test(m[0]);
    hits.push({
      id,
      line: m[0],
      struck,
      index: m.index,
      fullMatch: m[0],
    });
  }
  // Multiline openers: "- **BD-FOO (supersedes …,\n  per Intent):**"
  const multiRe =
    /^([-*]\s+)(?:~~)?\*\*(BD-[A-Z0-9-]+)\s*\([^)]*$/gim;
  while ((m = multiRe.exec(blueprint)) !== null) {
    const id = m[2] ?? "";
    if (hits.some((h) => h.index === m!.index)) continue;
    const struck = /~~/.test(m[0]);
    hits.push({
      id,
      line: m[0],
      struck,
      index: m.index,
      fullMatch: m[0],
    });
  }
  // JamPress / narrative style: "### BD-39a: Title" or "### ~~BD-FOO~~ (struck)"
  const headingRe =
    /^###\s+(?:~~)?(BD-[A-Z0-9-]+)(?:~~)?(?::|\s|\(|$)([^\n]*)$/gim;
  while ((m = headingRe.exec(blueprint)) !== null) {
    const id = m[1] ?? "";
    if (!id) continue;
    if (hits.some((h) => h.index === m!.index)) continue;
    const struck =
      /~~/.test(m[0]) ||
      /_\(superseded\)_/i.test(m[0]) ||
      /\(struck\)/i.test(m[0]);
    hits.push({
      id,
      line: m[0],
      struck,
      index: m.index,
      fullMatch: m[0],
    });
  }
  return hits;
}

function oneLineSummary(line: string, max = 120): string {
  const cleaned = line
    .replace(/^###\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/~~/g, "")
    .replace(/_\(superseded\)_/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

/**
 * Extract Live decisions body — supports legacy `## Live decisions` and the
 * probe-grounded `## Live decisions — verified` / `— claimed unverified` pair.
 */
export function extractLiveDecisions(blueprint: string): string {
  const verified =
    extractSection(blueprint, /Live decisions\s*[—-]\s*verified/i)?.trim() ??
    "";
  const claimed =
    extractSection(
      blueprint,
      /Live decisions\s*[—-]\s*claimed unverified/i,
    )?.trim() ?? "";
  if (verified || claimed) {
    const parts: string[] = [];
    if (verified) {
      parts.push(`${LIVE_VERIFIED_HEADING}\n\n${verified}`);
    }
    if (claimed) {
      parts.push(`${LIVE_CLAIMED_HEADING}\n\n${claimed}`);
    }
    return parts.join("\n\n");
  }
  const m = blueprint.match(
    /##\s+Live decisions\s*\n([\s\S]*?)(?=\n##\s|$)/i,
  );
  return m?.[1]?.trim() ?? "";
}

/**
 * Prefer verified live decisions, then claimed, for agent blueprint clips.
 */
export function clipBlueprintForPrompt(
  blueprint: string,
  maxChars = 6_000,
): string {
  const verified = extractSection(blueprint, /Live decisions\s*[—-]\s*verified/i);
  const claimed = extractSection(
    blueprint,
    /Live decisions\s*[—-]\s*claimed unverified/i,
  );
  const legacy = extractLiveDecisions(blueprint);

  const parts: string[] = [];
  if (verified?.trim()) {
    parts.push(`${LIVE_VERIFIED_HEADING}\n\n${verified.trim()}`);
  }
  if (claimed?.trim()) {
    parts.push(
      `${LIVE_CLAIMED_HEADING}\n\n_Do not treat as ground truth until probed._\n\n${claimed.trim()}`,
    );
  }
  if (!parts.length && legacy.trim()) {
    parts.push(`${LIVE_DECISIONS_HEADING}\n\n${legacy.trim()}`);
  }
  if (parts.length) {
    const block = `${parts.join("\n\n")}\n`;
    if (block.length >= maxChars) return block.slice(0, maxChars);
    const room = maxChars - block.length - 80;
    if (room < 200) return block;
    const decisions = extractSection(blueprint, /Decisions/i) ?? "";
    const activeLines = decisions
      .split("\n")
      .filter((l) => /BD-/i.test(l) && !/~~/.test(l))
      .slice(0, 8)
      .join("\n");
    if (!activeLines.trim()) return block;
    return `${block}\n### Active BD excerpts\n${activeLines.slice(0, room)}`;
  }
  const body = (blueprint ?? "").trim();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n…[truncated BLUEPRINT.md]`;
}

/**
 * Deterministic reconcile: intent-aware GC, dedupe BD ids (keep newest),
 * rebuild Live decisions (verified vs claimed when probes provided).
 */
export function reconcileBlueprintDecisions(
  blueprint: string,
  intent?: ChangeIntent | null,
  probes?: ProjectDecisionProbes | null,
): { blueprint: string; report: string[] } {
  const report: string[] = [];
  let next = garbageCollectSupersededMountBds(blueprint, intent);

  if (probes?.mount === "composer") {
    next = garbageCollectSupersededMountBds(next, {
      title: "probe",
      goal: "probe",
      uiMount: "composer",
      refinementOf: [],
      supersedes: ["BD-IN-BUBBLE-FORMS"],
      mustNot: [],
      rawDescription: "",
    });
    report.push("probe: mount=composer → strike BD-IN-BUBBLE-FORMS");
  } else if (probes?.mount === "bubble") {
    next = garbageCollectSupersededMountBds(next, {
      title: "probe",
      goal: "probe",
      uiMount: "bubble",
      refinementOf: [],
      supersedes: ["BD-COMPOSER-FORM-MODE"],
      mustNot: [],
      rawDescription: "",
    });
    report.push("probe: mount=bubble → strike BD-COMPOSER-FORM-MODE");
  }

  const hits = collectBdHits(next);
  const seen = new Map<string, BdHit>();
  const ordered = [...hits].sort((a, b) => b.index - a.index);
  const dropIndexes = new Set<number>();
  for (const hit of ordered) {
    const prev = seen.get(hit.id);
    if (!prev) {
      seen.set(hit.id, hit);
      continue;
    }
    dropIndexes.add(hit.index);
    report.push(`dedupe ${hit.id}: keep newest, strike older duplicate`);
  }

  if (dropIndexes.size > 0) {
    for (const hit of hits) {
      if (!dropIndexes.has(hit.index)) continue;
      if (hit.struck) continue;
      const struckLine = hit.fullMatch.replace(
        /^([-*]\s+)\*\*(BD-[A-Z0-9-]+)/i,
        "$1~~**$2**~~ _(duplicate)_",
      );
      next = next.replace(hit.fullMatch, struckLine);
    }
  }

  const liveHits = collectBdHits(next)
    .filter((h) => !h.struck && !/_\(duplicate\)_/i.test(h.fullMatch))
    .sort((a, b) => b.index - a.index);
  const uniqueLive: BdHit[] = [];
  const liveSeen = new Set<string>();
  for (const h of liveHits) {
    if (liveSeen.has(h.id)) continue;
    liveSeen.add(h.id);
    uniqueLive.push(h);
  }

  const hasBubble = uniqueLive.some((h) => h.id === "BD-IN-BUBBLE-FORMS");
  const hasComposer = uniqueLive.some((h) =>
    /^BD-COMPOSER-FORM-MODE/.test(h.id),
  );
  if (hasBubble && hasComposer) {
    const winnerIsComposer =
      intent?.uiMount === "composer" ||
      probes?.mount === "composer" ||
      (intent?.uiMount !== "bubble" && probes?.mount !== "bubble");
    const loserId = winnerIsComposer
      ? "BD-IN-BUBBLE-FORMS"
      : "BD-COMPOSER-FORM-MODE";
    next = next.replace(
      new RegExp(`^([-*]\\s+)\\*\\*${loserId}[^\\n*]*\\*\\*`, "gim"),
      `$1~~**${loserId}**~~ _(superseded — mount conflict)_`,
    );
    report.push(
      `mount conflict: struck ${loserId} (prefer ${winnerIsComposer ? "composer" : "bubble"})`,
    );
    for (let i = uniqueLive.length - 1; i >= 0; i--) {
      const id = uniqueLive[i]?.id ?? "";
      if (winnerIsComposer && id === "BD-IN-BUBBLE-FORMS") {
        uniqueLive.splice(i, 1);
      } else if (!winnerIsComposer && /^BD-COMPOSER-FORM-MODE/.test(id)) {
        uniqueLive.splice(i, 1);
      }
    }
  }

  const preferComposer =
    intent?.uiMount === "composer" ||
    probes?.mount === "composer" ||
    (intent?.uiMount !== "bubble" && probes?.mount !== "bubble");

  const filtered = uniqueLive.filter((h) => {
    if (hasBubble && hasComposer) {
      if (preferComposer && h.id === "BD-IN-BUBBLE-FORMS") return false;
      if (!preferComposer && /^BD-COMPOSER-FORM-MODE/.test(h.id)) return false;
    }
    return !/~~/.test(h.fullMatch);
  });

  const verifiedLines: string[] = [];
  const claimedLines: string[] = [];
  for (const h of filtered.slice(0, 40)) {
    const line = `- ${oneLineSummary(h.fullMatch)}`;
    if (probes && bdVerifiedByProbes(h.id, probes)) {
      verifiedLines.push(line);
    } else {
      claimedLines.push(line);
    }
  }

  let liveSection: string;
  if (probes) {
    liveSection = [
      LIVE_VERIFIED_HEADING,
      "",
      verifiedLines.length
        ? verifiedLines.join("\n")
        : "_No BD-* decisions verified by repo probes._",
      "",
      LIVE_CLAIMED_HEADING,
      "",
      "_Do not treat as ground truth until probed._",
      "",
      claimedLines.length ? claimedLines.join("\n") : "_None._",
      "",
    ].join("\n");
    report.push(
      `live decisions: ${verifiedLines.length} verified, ${claimedLines.length} claimed (probe mount=${probes.mount})`,
    );
  } else {
    const liveBody = filtered
      .map((h) => `- ${oneLineSummary(h.fullMatch)}`)
      .slice(0, 40)
      .join("\n");
    liveSection = `${LIVE_DECISIONS_HEADING}\n\n${
      liveBody || "_No active BD-* decisions parsed._"
    }\n`;
    report.push(`live decisions: ${filtered.length} active BD ids`);
  }

  next = next.replace(
    /##\s+Live decisions(?:\s*[—-]\s*(?:verified|claimed unverified))?\s*\n[\s\S]*?(?=\n##\s|$)/gi,
    "",
  );

  if (/^#\s+/m.test(next)) {
    next = next.replace(/^(#\s+[^\n]+\n+)/, `$1\n${liveSection}\n`);
  } else {
    next = `${liveSection}\n${next}`;
  }

  return { blueprint: next, report };
}

export function isUxPlacementKnowledge(text: string): boolean {
  return /uiMount|composer|form[- ]bubble|speech bubble|chat prompt|BD-(?:COMPOSER|IN-BUBBLE)|ux-placement|mount point/i.test(
    text,
  );
}
