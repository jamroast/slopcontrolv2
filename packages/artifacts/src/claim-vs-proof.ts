import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSection } from "./markdown.js";
import { extractCheckCells } from "./check-runners.js";
import { readPhaseDesignAcceptance } from "./design-loop.js";
import {
  detectThemeToggleInHtml,
  packHasThemeModes,
} from "./design-conceptual-model.js";
import { readPhaseDesignPack } from "./design-pack.js";

/**
 * Claim-vs-proof: Success Criteria claim a runtime outcome that Automated Checks
 * must prove finitely — not only grep that config text exists.
 *
 * Implemented:
 * - module-resolve (Vite/CSS alias / Can't resolve)
 * - theme/shell mount (Menubar hosts ThemeToggle + playground mounts Menubar)
 * - theme/shell visibility (mount + @source / built CSS utilities / non-utility fallback)
 *
 * Sibling classes (deferred gates — document only):
 * - Chat stream / Ollama OpenAI-compat routing (partial api-routing-complete-gate)
 * - Engagement fill+submit / uiMount (textual PHASE align + symbol greps)
 * - Database DDL migrate apply (CREATE TABLE presence only today)
 * - Brand logo not fallback (scaffold greps; designImage bind for unbound logos)
 */

export type RuntimeClaimKind =
  | "module-resolve"
  | "theme-shell-mount"
  | "theme-shell-visibility";

export type ClaimProofOpts = {
  projectRoot?: string;
  phaseId?: string;
};

/** Success Criteria claim module resolve / clean Vite CSS load. */
export function successCriteriaClaimsModuleResolve(text: string): boolean {
  return (
    /Can't resolve|cannot resolve|failed to resolve/i.test(text) ||
    /no\s+[`']?Can't resolve/i.test(text) ||
    /without\s+[`']?Can't resolve/i.test(text) ||
    /(?:vite|playground)\s+(?:starts?|start(?:s|ing)?)\b[^\n]{0,80}(?:resolve|error|Can't)/i.test(
      text,
    ) ||
    /CSS\s+loads?\b|@import\b[^\n]{0,60}works|styles?\s+resolv/i.test(text) ||
    /module\s+resolution|alias\s+resolv/i.test(text)
  );
}

/**
 * Automated Checks include a finite resolve proof (not long-lived `vite`/`pnpm dev`).
 * `vite build` is allowed; programmatic resolveId / createServer+close one-shots too.
 */
export function automatedChecksHaveFiniteResolveProof(
  checksText: string,
): boolean {
  if (/\bvite\s+build\b/i.test(checksText)) return true;
  if (/\b(?:pnpm|npm|yarn|bun)\s+exec\s+vite\s+build\b/i.test(checksText)) {
    return true;
  }
  if (/\bresolveId\b/i.test(checksText)) return true;
  if (
    /\bcreateServer\b/i.test(checksText) &&
    /\b(?:close|resolveId|pluginContainer)\b/i.test(checksText)
  ) {
    return true;
  }
  return false;
}

/**
 * Return PHASE validation issues when Success Criteria claim module resolve
 * but Automated Checks lack a finite resolve proof.
 */
export function validateModuleResolveClaimProof(phaseDoc: string): string[] {
  const sc = extractSection(phaseDoc, "Success Criteria") ?? "";
  if (!sc || !successCriteriaClaimsModuleResolve(sc)) {
    return [];
  }

  const cells = extractCheckCells(phaseDoc);
  const checksText = cells.map((c) => c.body).join("\n");
  if (automatedChecksHaveFiniteResolveProof(checksText)) {
    return [];
  }

  return [
    "Success Criteria claim module resolve / clean Vite CSS load (e.g. no `Can't resolve`), but Automated Checks lack a finite resolve proof. Add `vite build` (in the app/playground cwd) or a short Node resolveId/createServer one-shot — grep for alias strings alone is insufficient. Do not use long-lived `pnpm dev` / bare `vite`.",
  ];
}

/** Scope / Success Criteria claim the theme toggle lives on menubar / playground shell. */
export function phaseClaimsMenubarThemeToggle(text: string): boolean {
  const body = text ?? "";
  const mentionsToggle =
    /\bThemeToggle\b/i.test(body) ||
    /\btheme\s*toggle\b/i.test(body) ||
    /\bday\s*(?:and|[\/&-])?\s*night\b/i.test(body) ||
    /\blight\s*(?:and|[\/&-])?\s*dark\s+(?:mode\s+)?(?:switch|toggle|button)\b/i.test(
      body,
    );
  if (!mentionsToggle) return false;
  return (
    /\bmenubar\b|\bmenu\s*bar\b/i.test(body) ||
    /\bplayground\b/i.test(body) ||
    /\bshell\s+chrome\b/i.test(body) ||
    /\bsticky\s+top\b/i.test(body)
  );
}

/** Success Criteria claim the control is visible / utilities resolve (not mount alone). */
export function phaseClaimsThemeToggleVisible(text: string): boolean {
  const body = text ?? "";
  const visibility =
    /\bvisib(?:le|ility)\b/i.test(body) ||
    /\bnot\s+invisible\b/i.test(body) ||
    /\bicons?\s+(?:are\s+)?(?:visible|resolve)/i.test(body) ||
    /\butilit(?:y|ies)\s+resolv/i.test(body) ||
    /\bresolved\s+utilit/i.test(body) ||
    /\bpaint(?:s|ed)?\b/i.test(body) ||
    /\bcan\s+see\b|\bsee(?:able)?\b/i.test(body);
  if (!visibility) return false;
  return (
    /\bThemeToggle\b/i.test(body) ||
    /\btheme\s*toggle\b/i.test(body) ||
    /\bday\s*(?:and|[\/&-])?\s*night\b/i.test(body) ||
    /\bmenubar\b|\bmenu\s*bar\b/i.test(body)
  );
}

/** Checks prove shell hosts ThemeToggle and playground/App mounts Menubar. */
export function automatedChecksProveThemeToggleMounted(
  checksText: string,
): boolean {
  const body = checksText ?? "";
  const toggleInShell =
    (/<ThemeToggle\b/i.test(body) ||
      /\bThemeToggle\b/i.test(body) ||
      /\btheme-toggle\b/i.test(body)) &&
    (/menubar\.(tsx|jsx|ts|js|vue)/i.test(body) ||
      /shell\/menubar/i.test(body) ||
      /components\/shell\/menubar/i.test(body));
  const menubarInPlayground =
    (/<Menubar\b/i.test(body) || /\bMenubar\b/i.test(body)) &&
    (/playground\/src\/App\.(tsx|jsx|ts|js)/i.test(body) ||
      /playground\/App\.(tsx|jsx)/i.test(body) ||
      (/playground/i.test(body) && /\bApp\.(tsx|jsx)\b/i.test(body)));
  return toggleInShell && menubarInPlayground;
}

/** Export-only ThemeToggle greps are not a mount proof. */
export function checksAreExportOnlyThemeToggle(checksText: string): boolean {
  const body = checksText ?? "";
  if (!/export\s+(?:function|const)\s+ThemeToggle/i.test(body)) return false;
  return !automatedChecksProveThemeToggleMounted(body);
}

/**
 * Finite style-visibility proof for ThemeToggle in a Tailwind consumer (playground).
 * Import-order / bare vite build alone are insufficient.
 */
export function automatedChecksProveThemeToggleStyleVisibility(
  checksText: string,
): boolean {
  const body = checksText ?? "";

  // @source covering package ../src (or src components) in playground CSS entry
  if (
    /@source\b/i.test(body) &&
    (/(\.\.\/)?src/i.test(body) ||
      /components\/shell/i.test(body) ||
      /\*\.\{?tsx/i.test(body))
  ) {
    return true;
  }

  // Built CSS utility greps after vite build (critical ThemeToggle classes)
  const hasViteBuild =
    /\bvite\s+build\b/i.test(body) ||
    /\b(?:pnpm|npm|yarn|bun)\s+exec\s+vite\s+build\b/i.test(body);
  const hasDistCss =
    /dist\/assets\/.*\.css/i.test(body) ||
    /dist\/assets\/\*\.css/i.test(body) ||
    /assets\/index-[^'"\s]+\.css/i.test(body);
  const hasColorUtility =
    /text-text-secondary/i.test(body) ||
    /color:\s*var\(--text-secondary\)/i.test(body) ||
    /--text-secondary/i.test(body);
  const hasSizeUtility =
    /\bh-9\b/i.test(body) ||
    /\bw-9\b/i.test(body) ||
    /height:\s*var\(--/i.test(body) ||
    /width:\s*var\(--/i.test(body);
  if (hasViteBuild && hasDistCss && hasColorUtility && hasSizeUtility) {
    return true;
  }
  // Slightly looser: vite build + dist css grep for text-text-secondary (color is the invisible-icon failure)
  if (hasViteBuild && hasDistCss && hasColorUtility) {
    return true;
  }

  // Non-utility color/size fallback on ThemeToggle source
  if (
    (/theme-toggle\.(tsx|jsx|ts|js)/i.test(body) ||
      /ThemeToggle/i.test(body)) &&
    (/style=\{\{\s*color:\s*['"`]var\(--text-secondary\)/i.test(body) ||
      (/var\(--text-secondary\)/i.test(body) &&
        /(?:height|width|h-\[|w-\[)/i.test(body)) ||
      (/\.module\.(css|scss)/i.test(body) && /text-secondary/i.test(body)))
  ) {
    return true;
  }

  return false;
}

/** Import-order-only checks (tailwind first) without style visibility. */
export function checksAreImportOrderOnlyStyleFix(checksText: string): boolean {
  const body = checksText ?? "";
  const mentionsImportOrder =
    /@import\s+[\"']tailwindcss[\"']/i.test(body) &&
    (/first\s+line|first\s+import|import\s+order/i.test(body) ||
      /head\s+-n\s*1|tailwindcss.*first/i.test(body));
  if (!mentionsImportOrder) {
    // Also treat "grep tailwindcss first in index.css" patterns
    if (
      !(/index\.css/i.test(body) && /tailwindcss/i.test(body)) ||
      automatedChecksProveThemeToggleStyleVisibility(body)
    ) {
      return false;
    }
    return !automatedChecksProveThemeToggleStyleVisibility(body);
  }
  return !automatedChecksProveThemeToggleStyleVisibility(body);
}

function phaseHasAcceptedShellOrThemeDesign(
  opts?: ClaimProofOpts,
): boolean {
  if (!opts?.projectRoot || !opts.phaseId) return false;
  const acceptance = readPhaseDesignAcceptance(opts.projectRoot, opts.phaseId);
  if (
    acceptance?.features.some(
      (f) =>
        f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
    )
  ) {
    return true;
  }
  const pack = readPhaseDesignPack(opts.projectRoot, opts.phaseId);
  if (packHasThemeModes(pack)) return true;
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
      return detectThemeToggleInHtml(readFileSync(mockPath, "utf-8"));
    } catch {
      return false;
    }
  }
  return false;
}

function themeShellClaimApplies(
  phaseDoc: string,
  opts?: ClaimProofOpts,
): boolean {
  const scope = extractSection(phaseDoc, "Scope") ?? "";
  const success = extractSection(phaseDoc, "Success Criteria") ?? "";
  const claimSurface = `${scope}\n${success}`;
  const claimsMount = phaseClaimsMenubarThemeToggle(claimSurface);
  const claimsVisible = phaseClaimsThemeToggleVisible(claimSurface);
  const mentionsToggle =
    /\bThemeToggle\b/i.test(claimSurface) ||
    /\btheme\s*toggle\b/i.test(claimSurface) ||
    /\bday\s*(?:and|[\/&-])?\s*night\b/i.test(claimSurface);
  const designBound = phaseHasAcceptedShellOrThemeDesign(opts);
  return (
    claimsMount ||
    claimsVisible ||
    (designBound && mentionsToggle)
  );
}

/**
 * When PHASE claims menubar/playground theme toggle (or design accepted
 * theme_modes/applied_shell and PHASE mentions ThemeToggle), Automated Checks
 * must prove Menubar mounts ThemeToggle and playground mounts Menubar.
 * Export-only greps are insufficient.
 */
export function validateThemeShellMountClaimProof(
  phaseDoc: string,
  opts?: ClaimProofOpts,
): string[] {
  if (!themeShellClaimApplies(phaseDoc, opts)) {
    return [];
  }

  const cells = extractCheckCells(phaseDoc);
  const checksText = cells.map((c) => c.body).join("\n");
  if (automatedChecksProveThemeToggleMounted(checksText)) {
    return [];
  }

  const exportOnly = checksAreExportOnlyThemeToggle(checksText);
  return [
    exportOnly
      ? "Success Criteria / Scope claim menubar or playground ThemeToggle, but Automated Checks only prove `export function ThemeToggle` — add greps that `<ThemeToggle` is mounted in the shell menubar and `<Menubar` is mounted in playground App (export-only is insufficient)."
      : "Success Criteria / Scope claim menubar or playground ThemeToggle (or design accepted theme_modes/applied_shell), but Automated Checks lack mount proofs. Require both: ThemeToggle in shell/menubar source, and Menubar in playground App — not export-only greps.",
  ];
}

/**
 * Mounted ≠ visible. Require finite style proof: @source package tree, built CSS
 * utilities (text-text-secondary / size), or non-utility color/size fallback.
 * Import-order-only and bare vite build are insufficient.
 */
export function validateThemeShellVisibilityClaimProof(
  phaseDoc: string,
  opts?: ClaimProofOpts,
): string[] {
  if (!themeShellClaimApplies(phaseDoc, opts)) {
    return [];
  }

  const success = extractSection(phaseDoc, "Success Criteria") ?? "";
  const scope = extractSection(phaseDoc, "Scope") ?? "";
  const claimSurface = `${scope}\n${success}`;
  // Always require style proof when mount claim applies for theme shell —
  // design/ask false-greens proved mount without paint.
  const forceVisibility =
    phaseClaimsThemeToggleVisible(claimSurface) ||
    phaseClaimsMenubarThemeToggle(claimSurface) ||
    phaseHasAcceptedShellOrThemeDesign(opts);

  if (!forceVisibility) return [];

  const cells = extractCheckCells(phaseDoc);
  const checksText = cells.map((c) => c.body).join("\n");

  if (automatedChecksProveThemeToggleStyleVisibility(checksText)) {
    return [];
  }

  if (checksAreImportOrderOnlyStyleFix(checksText)) {
    return [
      "Success Criteria / Scope claim ThemeToggle visibility (or design-bound theme shell), but Automated Checks only prove CSS import order (`@import \"tailwindcss\"` first). That is insufficient — also prove style emission: `@source` covering package `../src` components, or after `vite build` grep built `dist/assets/*.css` for ThemeToggle utilities (`text-text-secondary` / size), or a non-utility `var(--text-secondary)` color/size fallback on ThemeToggle.",
    ];
  }

  const hasViteOnly =
    automatedChecksHaveFiniteResolveProof(checksText) &&
    !automatedChecksProveThemeToggleStyleVisibility(checksText);

  return [
    hasViteOnly
      ? "Success Criteria / Scope claim ThemeToggle on menubar/playground (or design-bound theme shell), but Automated Checks only run `vite build` without proving ThemeToggle utilities land in built CSS. Mounted ≠ visible — add `@source \"../src/**/*.{ts,tsx}\"` (or equivalent) greps, or grep built `dist/assets/*.css` for `text-text-secondary` (and a size utility), or prove ThemeToggle uses non-utility `var(--text-secondary)` color/size."
      : "Success Criteria / Scope claim ThemeToggle on menubar/playground (or design-bound theme shell), but Automated Checks lack a finite **style visibility** proof. Require mount greps plus one of: `@source` covering package `src` in the playground CSS entry; `vite build` + grep built CSS for ThemeToggle utilities (`text-text-secondary` / `h-9`); or non-utility color/size fallback on ThemeToggle. Import-order-only greps are insufficient.",
  ];
}

/** Extensible entry point for claim-vs-proof PHASE validation. */
export function validateRuntimeClaimProofs(
  phaseDoc: string,
  opts?: ClaimProofOpts,
): string[] {
  return [
    ...validateModuleResolveClaimProof(phaseDoc),
    ...validateThemeShellMountClaimProof(phaseDoc, opts),
    ...validateThemeShellVisibilityClaimProof(phaseDoc, opts),
  ];
}
