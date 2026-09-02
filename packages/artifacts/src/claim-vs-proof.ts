import { extractSection } from "./markdown.js";
import { extractCheckCells } from "./check-runners.js";

/**
 * Claim-vs-proof: Success Criteria claim a runtime outcome that Automated Checks
 * must prove finitely — not only grep that config text exists.
 *
 * Implemented:
 * - module-resolve (Vite/CSS alias / Can't resolve / Next build)
 *
 * Theme/shell mount, visibility, and content-width claim detection were removed:
 * they were jamroast-specific (ThemeToggle / Menubar / content-max) and produced
 * regex false-positives (e.g. "painted … Menubar" prose triggering ThemeToggle
 * mount proofs). The LLM phase-quality judge owns those claim-vs-proof checks.
 */

export type RuntimeClaimKind = "module-resolve";

export type ClaimProofOpts = {
  projectRoot?: string;
  phaseId?: string;
};

/**
 * Strip pasted research dumps from Scope so scaffold / research excerpts do not
 * invent claims without Success Criteria intent.
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
 * Claim surface for claim detection: Success Criteria, File Changes, Layout,
 * and Scope without Research notes dumps.
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

/** Extensible entry point for claim-vs-proof PHASE validation. */
export function validateRuntimeClaimProofs(
  phaseDoc: string,
  _opts?: ClaimProofOpts,
): string[] {
  return [...validateModuleResolveClaimProof(phaseDoc)];
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
