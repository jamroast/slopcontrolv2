import { extractSection } from "./markdown.js";
import {
  detectThemeToggleInHtml,
  packHasThemeModes,
} from "./design-conceptual-model.js";
import { readPhaseDesignAcceptance } from "./design-loop.js";
import { readPhaseDesignPack } from "./design-pack.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Operator asks to add / show / implement a missing theme toggle on the menubar
 * (not a pure wiring audit).
 */
export function operatorRequestsMissingThemeControl(
  description: string,
): boolean {
  const text = description ?? "";
  const action =
    /\b(?:not\s+appearing|missing|absent|can't\s+see|cannot\s+see|add(?:ing)?|implement(?:ing)?|put|place|show|make\s+(?:sure|visible|obvious))\b/i.test(
      text,
    );
  if (!action) return false;
  return (
    /\b(?:theme\s*toggle|ThemeToggle|day\s*(?:and|[\/&-])?\s*night|light\s*(?:and|[\/&-])?\s*dark(?:\s+mode)?(?:\s+(?:switch|toggle|button))?)\b/i.test(
      text,
    ) ||
    (/\bmenubar\b|\bmenu\s*bar\b/i.test(text) &&
      /\b(?:theme|day\s*(?:and|[\/&-])?\s*night|light\s*(?:and|[\/&-])?\s*dark)\b/i.test(
        text,
      ))
  );
}

/** PHASE declares review-only / no product file changes. */
export function phaseDocDeclaresReviewOnlyNoFileChanges(
  phaseDoc: string,
): boolean {
  const doc = phaseDoc ?? "";
  if (
    /\breview-only\b/i.test(doc) ||
    /\bno\s+file\s+changes\s+are\s+required\b/i.test(doc) ||
    /\bno\s+code\s+changes\s+are\s+required\b/i.test(doc)
  ) {
    return true;
  }
  const fileChanges = extractSection(doc, "File Changes") ?? "";
  return (
    /^\s*\*\*No\s+file\s+changes/im.test(fileChanges) ||
    /^\s*No\s+file\s+changes\s+are\s+required/im.test(fileChanges)
  );
}

export type AntiAuditThemeOpts = {
  description: string;
  phaseDoc: string;
  /** Bound mock has a theme toggle control. */
  togglePresent?: boolean;
  /** design ACCEPTANCE accepted theme_modes or applied_shell. */
  designShellOrThemeAccepted?: boolean;
  projectRoot?: string;
  phaseId?: string;
};

function resolveDesignThemeSignals(opts: AntiAuditThemeOpts): {
  togglePresent: boolean;
  designShellOrThemeAccepted: boolean;
} {
  let togglePresent = Boolean(opts.togglePresent);
  let designShellOrThemeAccepted = Boolean(opts.designShellOrThemeAccepted);
  if (opts.projectRoot && opts.phaseId) {
    const acceptance = readPhaseDesignAcceptance(
      opts.projectRoot,
      opts.phaseId,
    );
    if (
      acceptance?.features.some(
        (f) =>
          f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
      )
    ) {
      designShellOrThemeAccepted = true;
    }
    const pack = readPhaseDesignPack(opts.projectRoot, opts.phaseId);
    if (packHasThemeModes(pack)) designShellOrThemeAccepted = true;
    const mockPath = join(
      opts.projectRoot,
      ".slopcontrol",
      "phases",
      opts.phaseId,
      "design",
      "mock.html",
    );
    if (existsSync(mockPath)) {
      try {
        if (detectThemeToggleInHtml(readFileSync(mockPath, "utf-8"))) {
          togglePresent = true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { togglePresent, designShellOrThemeAccepted };
}

/**
 * Fail when operator asked for a missing/visible theme control and PHASE
 * closed as review-only despite a bound mock toggle / accepted shell theme.
 */
export function phaseDocRejectsMissingThemeAudit(
  opts: AntiAuditThemeOpts,
): { ok: boolean; issues: string[] } {
  if (!operatorRequestsMissingThemeControl(opts.description)) {
    return { ok: true, issues: [] };
  }
  if (!phaseDocDeclaresReviewOnlyNoFileChanges(opts.phaseDoc)) {
    return { ok: true, issues: [] };
  }
  const { togglePresent, designShellOrThemeAccepted } =
    resolveDesignThemeSignals(opts);
  if (!togglePresent && !designShellOrThemeAccepted) {
    return { ok: true, issues: [] };
  }
  return {
    ok: false,
    issues: [
      "Operator asked to add/show a missing menubar theme (day/night) control, and a bound design mock / accepted theme_modes|applied_shell exists — PHASE must not close as review-only / \"No file changes are required.\" Plan visible playground Menubar delivery matching the accepted mock control, with Automated Checks that prove (1) ThemeToggle mounted in shell menubar and Menubar in playground App, and (2) style visibility via `@source` covering package `../src`, or `vite build` + grep built CSS for ThemeToggle utilities (`text-text-secondary` / size), or a non-utility `var(--text-secondary)` fallback. Import-order-only greps are insufficient.",
    ],
  };
}

/** Research/draft prompt note when anti-audit theme delivery applies. */
export function formatAntiAuditThemeDeliveryNote(opts: {
  description: string;
  togglePresent?: boolean;
  designShellOrThemeAccepted?: boolean;
  projectRoot?: string;
  phaseId?: string;
}): string {
  if (!operatorRequestsMissingThemeControl(opts.description)) return "";
  const { togglePresent, designShellOrThemeAccepted } =
    resolveDesignThemeSignals({
      description: opts.description,
      phaseDoc: "",
      togglePresent: opts.togglePresent,
      designShellOrThemeAccepted: opts.designShellOrThemeAccepted,
      projectRoot: opts.projectRoot,
      phaseId: opts.phaseId,
    });
  if (!togglePresent && !designShellOrThemeAccepted) return "";
  return `
CRITICAL theme control delivery (operator missing/add language + bound design toggle):
- Do NOT close as review-only or write "No file changes are required."
- Goal: **visible** playground/menubar delivery matching the accepted mock day/night ThemeToggle (mounted ≠ visible).
- File Changes must touch shell ThemeToggle / Menubar and/or playground CSS App entry as needed for visibility.
- Automated Checks must prove \`<ThemeToggle\` in shell menubar AND \`<Menubar\` in playground App, **plus** style emission: \`@source "../src/**/*.{ts,tsx}"\` (or equivalent) in playground CSS, **or** after \`vite build\` grep built \`dist/assets/*.css\` for \`text-text-secondary\` (and a size utility), **or** non-utility color/size on ThemeToggle. Import-order-only (\`@import "tailwindcss"\` first) is **insufficient**.
`;
}
