import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSection } from "./markdown.js";
import { extractCheckCells } from "./check-runners.js";
import { readPhaseDesignAcceptance } from "./design-loop.js";
import {
  detectThemeToggleInHtml,
  packHasThemeModes,
} from "./design-conceptual-model.js";
import {
  mockHasContentAlignedMenubar,
  readPhaseDesignPack,
} from "./design-pack.js";

/**
 * Claim-vs-proof: Success Criteria claim a runtime outcome that Automated Checks
 * must prove finitely — not only grep that config text exists.
 *
 * Implemented:
 * - module-resolve (Vite/CSS alias / Can't resolve / Next build)
 * - theme/shell mount (Menubar hosts ThemeToggle + playground or product shell)
 * - theme/shell visibility (mount + @source / built CSS utilities / non-utility fallback)
 * - shell content-width layout (menubar inner `--content-max` matching page content)
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
  | "theme-shell-visibility"
  | "shell-content-width";

export type ClaimProofOpts = {
  projectRoot?: string;
  phaseId?: string;
};

/**
 * Strip pasted research dumps from Scope so scaffold / research excerpts do not
 * invent ThemeToggle or content-max claims without Success Criteria intent.
 */
export function stripResearchNotesFromScope(scope: string): string {
  const s = scope ?? "";
  return s
    .replace(
      /###\s*Research notes\b[\s\S]*?(?=\n###\s|\n##\s|$)/gi,
      "\n",
    )
    .replace(
      /##\s*Research notes\b[\s\S]*?(?=\n##\s|$)/gi,
      "\n",
    )
    .trim();
}

/**
 * Claim surface for mount/visibility/content-width detection: Success Criteria,
 * File Changes, Layout, and Scope without Research notes dumps.
 */
export function claimSurfaceFromPhaseDoc(phaseDoc: string): string {
  const scope = stripResearchNotesFromScope(
    extractSection(phaseDoc, "Scope") ?? "",
  );
  const success = extractSection(phaseDoc, "Success Criteria") ?? "";
  const fileChanges = extractSection(phaseDoc, "File Changes") ?? "";
  const layout = extractSection(phaseDoc, "Layout") ?? "";
  return [scope, success, fileChanges, layout].filter(Boolean).join("\n");
}

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
 * `vite build`, `next build`, and package-manager `build` are allowed; resolveId /
 * createServer+close one-shots too.
 */
export function automatedChecksHaveFiniteResolveProof(
  checksText: string,
): boolean {
  if (/\bvite\s+build\b/i.test(checksText)) return true;
  if (/\b(?:pnpm|npm|yarn|bun)\s+exec\s+vite\s+build\b/i.test(checksText)) {
    return true;
  }
  if (/\bnext\s+build\b/i.test(checksText)) return true;
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/i.test(checksText)) {
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
    "Success Criteria claim module resolve / clean Vite CSS load (e.g. no `Can't resolve`), but Automated Checks lack a finite resolve proof. Add `vite build` (app/playground), `next build` / `pnpm build` (Next apps), or a short Node resolveId/createServer one-shot — grep for alias strings alone is insufficient. Do not use long-lived `pnpm dev` / bare `vite`.",
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

/** Checks prove shell hosts ThemeToggle and app mounts Menubar (playground or product). */
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
      /components\/shell\/menubar/i.test(body) ||
      /jampress-menubar/i.test(body));
  const menubarInPlayground =
    (/<Menubar\b/i.test(body) || /\bMenubar\b/i.test(body)) &&
    (/playground\/src\/App\.(tsx|jsx|ts|js)/i.test(body) ||
      /playground\/App\.(tsx|jsx)/i.test(body) ||
      (/playground/i.test(body) && /\bApp\.(tsx|jsx)\b/i.test(body)));
  const menubarInProductShell = automatedChecksProveProductShellMenubarMount(body);
  return toggleInShell && (menubarInPlayground || menubarInProductShell);
}

/**
 * Product apps (Next.js JamPress, etc.) mount menubar in layout shells — not
 * playground/src/App.tsx.
 */
export function automatedChecksProveProductShellMenubarMount(
  checksText: string,
): boolean {
  const body = checksText ?? "";
  const menubarRef =
    /<Menubar\b/i.test(body) ||
    /\bMenubar\b/i.test(body) ||
    /\bJampressMenubar\b/i.test(body) ||
    /jampress-menubar/i.test(body) ||
    /from\s+['"][^'"]*menubar/i.test(body);
  if (!menubarRef) return false;
  return (
    /(?:marketing|portal|app)-shell\.(tsx|jsx|ts|js)/i.test(body) ||
    /components\/layout\//i.test(body) ||
    /src\/app\/(?:\(\w+\)\/)?layout\.tsx/i.test(body) ||
    /app\/(?:\(\w+\)\/)?layout\.tsx/i.test(body)
  );
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
  const hasNextBuild =
    /\bnext\s+build\b/i.test(body) ||
    (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/i.test(body) &&
      !hasViteBuild);
  const hasDistCss =
    /dist\/assets\/.*\.css/i.test(body) ||
    /dist\/assets\/\*\.css/i.test(body) ||
    /assets\/index-[^'"\s]+\.css/i.test(body) ||
    /\.next\/(?:static\/)?(?:css\/)?/i.test(body);
  const hasColorUtility =
    /text-text-secondary/i.test(body) ||
    /color:\s*var\(--text-secondary\)/i.test(body) ||
    /--text-secondary/i.test(body);
  const hasSizeUtility =
    /\bh-9\b/i.test(body) ||
    /\bw-9\b/i.test(body) ||
    /height:\s*var\(--/i.test(body) ||
    /width:\s*var\(--/i.test(body);
  if (
    (hasViteBuild || hasNextBuild) &&
    hasDistCss &&
    hasColorUtility &&
    hasSizeUtility
  ) {
    return true;
  }
  // Slightly looser: build + css grep for text-text-secondary (color is the invisible-icon failure)
  if ((hasViteBuild || hasNextBuild) && hasDistCss && hasColorUtility) {
    return true;
  }
  // Next.js: build + semantic token grep without requiring a dist path (agent may grep source CSS)
  if (
    hasNextBuild &&
    hasColorUtility &&
    (/globals\.css/i.test(body) ||
      /tokens\.css/i.test(body) ||
      /@jamroast\/components/i.test(body) ||
      hasDistCss)
  ) {
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
  const claimSurface = claimSurfaceFromPhaseDoc(phaseDoc);
  const claimsMount = phaseClaimsMenubarThemeToggle(claimSurface);
  const claimsVisible = phaseClaimsThemeToggleVisible(claimSurface);
  const mentionsToggle =
    /\bThemeToggle\b/i.test(claimSurface) ||
    /\btheme\s*toggle\b/i.test(claimSurface) ||
    /\bday\s*(?:and|[\/&-])?\s*night\b/i.test(claimSurface);
  const designBound = phaseHasAcceptedShellOrThemeDesign(opts);
  // Design-bound theme/shell forces mount proofs even without prose mentions.
  return claimsMount || claimsVisible || (designBound && mentionsToggle) || designBound;
}

/**
 * When PHASE claims menubar/playground theme toggle (or design accepted
 * theme_modes/applied_shell), Automated Checks must prove Menubar mounts
 * ThemeToggle and playground or product shell mounts Menubar.
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
      ? "Success Criteria / Scope claim menubar or playground ThemeToggle, but Automated Checks only prove `export function ThemeToggle` — add greps that `<ThemeToggle` is mounted in the shell menubar and Menubar/JampressMenubar is mounted in playground App or product shell (marketing/portal/layout) — export-only is insufficient."
      : "Success Criteria / Scope claim menubar or playground ThemeToggle (or design accepted theme_modes/applied_shell), but Automated Checks lack mount proofs. Require both: ThemeToggle in shell/menubar source, and Menubar/JampressMenubar mount in playground App **or** product layout shell (e.g. portal-shell / marketing-shell) — not export-only greps.",
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

  const claimSurface = claimSurfaceFromPhaseDoc(phaseDoc);
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
      "Success Criteria / Scope claim ThemeToggle visibility (or design-bound theme shell), but Automated Checks only prove CSS import order (`@import \"tailwindcss\"` first). That is insufficient — also prove style emission: `@source` covering package `../src` components, or after `vite build` / `pnpm build` grep built CSS / globals / package tokens for ThemeToggle utilities (`text-text-secondary` / size), or a non-utility `var(--text-secondary)` color/size fallback on ThemeToggle.",
    ];
  }

  const hasBuildOnly =
    automatedChecksHaveFiniteResolveProof(checksText) &&
    !automatedChecksProveThemeToggleStyleVisibility(checksText);

  return [
    hasBuildOnly
      ? "Success Criteria / Scope claim ThemeToggle on menubar/playground (or design-bound theme shell), but Automated Checks only run a build without proving ThemeToggle utilities land in CSS. Mounted ≠ visible — add `@source` covering package src, or grep built CSS / `globals.css` / package tokens for `text-text-secondary` (and a size utility), or prove ThemeToggle uses non-utility `var(--text-secondary)` color/size."
      : "Success Criteria / Scope claim ThemeToggle on menubar/playground (or design-bound theme shell), but Automated Checks lack a finite **style visibility** proof. Require mount greps plus one of: `@source` covering package `src` in the playground CSS entry; `vite build` / `pnpm build` / `next build` + grep CSS for ThemeToggle utilities (`text-text-secondary` / `h-9`); or non-utility color/size fallback on ThemeToggle. Import-order-only greps are insufficient.",
  ];
}

/** PHASE prose claims content-aligned / centred menubar matching page width. */
export function phaseClaimsContentAlignedMenubar(text: string): boolean {
  const t = text ?? "";
  return (
    /menubar|menu\s*bar|top\s*bar|shell\s*chrome/i.test(t) &&
    (/content-max|--content-max/i.test(t) ||
      /menubar__inner|inner\s+(?:bar|container|wrapper)/i.test(t) ||
      /\b(?:centre|center|centred|centered)\b.{0,60}\b(?:menu|menubar|nav\s*bar)\b/i.test(
        t,
      ) ||
      /\b(?:menu|menubar|nav\s*bar)\b.{0,80}\b(?:same\s+width|page\s+content|content\s+width|landing\s+content)\b/i.test(
        t,
      ) ||
      /\balign\b.{0,40}\b(?:menu|menubar)\b.{0,60}\b(?:content|page|landing)\b/i.test(
        t,
      ))
  );
}

function phaseHasAppliedShellWithContentAlignedMenubar(
  opts?: ClaimProofOpts,
): boolean {
  if (!opts?.projectRoot || !opts.phaseId) return false;
  const acceptance = readPhaseDesignAcceptance(opts.projectRoot, opts.phaseId);
  const appliedShell = Boolean(
    acceptance?.features.some((f) => f.accepted && f.id === "applied_shell"),
  );
  const pack = readPhaseDesignPack(opts.projectRoot, opts.phaseId);
  const packShell =
    pack?.inScope?.includes("applied_shell") &&
    (pack.shell?.some((s) =>
      /content-max|menubar__inner|inner bar/i.test(s),
    ) ??
      false);
  if (packShell) return true;
  if (!appliedShell && !pack?.inScope?.includes("applied_shell")) return false;
  const mockPath = join(
    opts.projectRoot,
    ".slopcontrol",
    "phases",
    opts.phaseId,
    "design",
    "mock.html",
  );
  if (!existsSync(mockPath)) return false;
  try {
    return mockHasContentAlignedMenubar(readFileSync(mockPath, "utf-8"));
  } catch {
    return false;
  }
}

function shellContentWidthClaimApplies(
  phaseDoc: string,
  opts?: ClaimProofOpts,
): boolean {
  const claimSurface = claimSurfaceFromPhaseDoc(phaseDoc);
  return (
    phaseClaimsContentAlignedMenubar(claimSurface) ||
    phaseHasAppliedShellWithContentAlignedMenubar(opts)
  );
}

/** Automated Checks prove menubar uses content-max inner layout + Menubar mount. */
export function automatedChecksProveContentAlignedMenubar(
  checksText: string,
): boolean {
  const body = checksText ?? "";
  const contentMax =
    /--content-max/i.test(body) ||
    /maxWidth:\s*['"]?var\(--content-max\)/i.test(body) ||
    /max-w-\[var\(--content-max\)\]/i.test(body) ||
    /menubar__inner/i.test(body) ||
    /landing-header-inner/i.test(body);
  const menubarFile =
    /menubar\.(tsx|jsx|ts|js|vue)/i.test(body) ||
    /shell\/menubar/i.test(body) ||
    /components\/shell\/menubar/i.test(body) ||
    /jampress-menubar/i.test(body);
  const playgroundMount =
    (/playground/i.test(body) || /App\.(tsx|jsx)/i.test(body)) &&
    (/<Menubar\b/.test(body) ||
      /Menubar/.test(body) ||
      /from\s+['"][^'"]*menubar/i.test(body));
  const productMount = automatedChecksProveProductShellMenubarMount(body);
  return contentMax && menubarFile && (playgroundMount || productMount);
}

/**
 * When design-bound applied_shell has a content-aligned menubar (or PHASE claims
 * it), Automated Checks must prove Menubar implements `--content-max` inner
 * layout — ViewSwitcher-only greps are insufficient.
 */
export function validateShellContentWidthClaimProof(
  phaseDoc: string,
  opts?: ClaimProofOpts,
): string[] {
  if (!shellContentWidthClaimApplies(phaseDoc, opts)) {
    return [];
  }

  const cells = extractCheckCells(phaseDoc);
  const checksText = cells.map((c) => c.body).join("\n");
  if (automatedChecksProveContentAlignedMenubar(checksText)) {
    return [];
  }

  const viewSwitcherOnly =
    /ViewSwitcher|viewSwitcher|activeView/i.test(checksText) &&
    !/--content-max|menubar__inner|landing-header-inner/i.test(checksText);

  return [
    viewSwitcherOnly
      ? "Design/PHASE claim a content-aligned menubar (inner bar at `--content-max` matching page content), but Automated Checks only prove ViewSwitcher / view wiring. Add greps that menubar source uses `--content-max` (or `menubar__inner` / maxWidth var) and that playground App **or** product shell (portal/marketing/layout) mounts Menubar/JampressMenubar."
      : "Design/PHASE claim a content-aligned menubar (applied_shell + mock/pack content-max layout, or Scope/Success Criteria about centred menubar / same width as page content), but Automated Checks lack proofs. Require: (1) menubar source grep for `--content-max` or equivalent inner wrapper, (2) Menubar/JampressMenubar mount in playground App **or** product layout shell — not ViewSwitcher-only greps.",
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
    ...validateShellContentWidthClaimProof(phaseDoc, opts),
  ];
}

/** Success Criteria + Automated Checks excerpt for the LLM judge. */
export function claimProofExcerptFromPhaseDoc(phaseDoc: string): string {
  const success = extractSection(phaseDoc, "Success Criteria") ?? "";
  const checksSection = extractSection(phaseDoc, "Automated Checks");
  const checks =
    checksSection ??
    extractCheckCells(phaseDoc)
      .map((c) => c.body)
      .join("\n\n");
  return [
    "## Success Criteria",
    success,
    "## Automated Checks",
    checks,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Best-effort claim-kind label for a deterministic issue string. */
export function claimKindLabelForIssue(issue: string): string {
  if (/module resolve|clean Vite CSS load/i.test(issue)) return "module-resolve";
  if (/mount proofs|export-only|mounted in the shell menubar/i.test(issue)) {
    return "theme-shell-mount";
  }
  if (/style visibility|utilities land in CSS|import order/i.test(issue)) {
    return "theme-shell-visibility";
  }
  if (/content-aligned menubar|--content-max/i.test(issue)) {
    return "shell-content-width";
  }
  return "runtime-claim";
}

/** Structural verdict shape (mirrors @slopcontrol/llm claim-proof-llm). */
export type ClaimProofJudgeVerdict = {
  genuineGap?: boolean;
  reason?: string;
  existingProof?: string;
  suggestedCheck?: string;
};

/**
 * Injected LLM judge. artifacts does NOT depend on @slopcontrol/llm — the
 * orchestrator binds judgeClaimProofViaLlm to endpoint/model.
 */
export type ClaimProofJudgeFn = (input: {
  claim: string;
  issue: string;
  phaseDocExcerpt: string;
}) => Promise<ClaimProofJudgeVerdict>;

export type RuntimeClaimProofAsyncResult = {
  /** Gaps confirmed genuine by the judge (blockers). */
  issues: string[];
  /** Deterministic gaps the judge rejected, kept for logging. */
  warnings: string[];
};

/**
 * LLM-refined claim-vs-proof validation: deterministic validators run first,
 * then the judge arbitrates each flagged gap. genuineGap=false drops the
 * issue into `warnings`; a judge error keeps the issue (fail closed).
 */
export async function validateRuntimeClaimProofsAsync(
  phaseDoc: string,
  opts?: ClaimProofOpts & { judgeFn?: ClaimProofJudgeFn },
): Promise<RuntimeClaimProofAsyncResult> {
  const issues = validateRuntimeClaimProofs(phaseDoc, opts);
  if (!opts?.judgeFn || issues.length === 0) {
    return { issues, warnings: [] };
  }

  const excerpt = claimProofExcerptFromPhaseDoc(phaseDoc);
  const kept: string[] = [];
  const warnings: string[] = [];
  for (const issue of issues) {
    try {
      const verdict = await opts.judgeFn({
        claim: claimKindLabelForIssue(issue),
        issue,
        phaseDocExcerpt: excerpt,
      });
      if (verdict.genuineGap === false) {
        warnings.push(
          `deterministic gap rejected by LLM judge: ${issue}` +
            (verdict.reason?.trim() ? ` — ${verdict.reason.trim()}` : "") +
            (verdict.existingProof?.trim()
              ? ` (existing proof: ${verdict.existingProof.trim()})`
              : ""),
        );
      } else {
        kept.push(
          verdict.suggestedCheck?.trim()
            ? `${issue}\n  Suggested check (LLM judge): ${verdict.suggestedCheck.trim()}`
            : issue,
        );
      }
    } catch {
      kept.push(issue);
    }
  }
  return { issues: kept, warnings };
}

export type ClaimProofGuidanceOpts = {
  /** DESIGN_PACK.shell bullets when design-bound */
  shellNotes?: string[];
  /** theme_modes or applied_shell in scope */
  designShellOrTheme?: boolean;
};

/**
 * Shared Automated Checks guidance for draft/research across design, ask, and
 * plan promotes — playground component libs and Next.js product apps.
 */
export function formatClaimProofChecksGuidance(
  opts?: ClaimProofGuidanceOpts,
): string {
  const dual =
    opts?.shellNotes?.some((s) =>
      /Landing menubar|Dashboard menubar: full-viewport|Dashboard shell: fill/i.test(
        s,
      ),
    ) ?? false;
  const lines = [
    "Claim-vs-proof Automated Checks (required when Scope/Success Criteria or design accept claim theme/shell/content-max):",
    "",
    "### Playground component library",
    "- Mount: `grep '<ThemeToggle'` in shell menubar source AND `grep '<Menubar'` in `playground/src/App.tsx`.",
    "- Visibility: `@source` covering package `../src` in playground CSS, OR `vite build` + grep `dist/assets/*.css` for `text-text-secondary` (and a size utility).",
    "- Content-max: menubar source greps `--content-max` / `menubar__inner` / `maxWidth: var(--content-max)` plus playground Menubar mount.",
    "",
    "### Product Next.js app (e.g. JamPress)",
    "- Mount: `grep '<ThemeToggle'` in `*menubar*` (e.g. `jampress-menubar.tsx`) AND `JampressMenubar` / `<Menubar` in `marketing-shell` / `portal-shell` / app `layout.tsx` (playground App is not required).",
    "- Visibility: `pnpm build` / `next build` plus grep `globals.css` or package tokens / built CSS for `text-text-secondary` or `--text-secondary`.",
    "- Content-max: `--content-max` on menubar + product shell mount greps above.",
    "- Module resolve: `pnpm build` / `next build` counts as a finite resolve proof (not only `vite build`).",
  ];
  if (dual || opts?.designShellOrTheme) {
    lines.push(
      "",
      "### Dual chrome (when DESIGN_PACK.shell distinguishes landing vs dashboard)",
      "- Landing: inner bar at `max-width: var(--content-max)`.",
      "- Dashboard: full-viewport-width outer bar; viewport-filling shell (`min-height: calc(100vh - var(--bar-h))`) — do not collapse to one menubar for both.",
    );
  }
  return lines.join("\n");
}
