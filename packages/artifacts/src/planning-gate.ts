/** Shared prompt contract for draft, review revision, and repair agents. */
export const PLANNING_AUTOMATED_CHECKS_RULES = `## Automated Checks rules (MUST obey on every PHASE.md write)
- One fenced cell per process (\`\`\`bash / \`\`\`typescript / \`lang cmd=…\`).
- Checks must be finite: no dev servers (\`next dev\`, \`pnpm dev\`), no bare \`docker compose up\`.
- Runtime probes must not restart infra: SlopControl verify already brings up test-services (Postgres/Redis/…). Do NOT \`docker compose up\` any service and do NOT add \`trap 'docker compose down' EXIT\` in checks. DB-dependent checks assume services are up: \`export DATABASE_URL=… && pnpm db:migrate && pnpm seed && npx vitest run <file>\`; app-runtime proofs use build/typecheck or a short Node one-shot.
- Static proofs use \`grep -q\` per token joined by \`&&\` — never same-line \`.*\` chains.
- Never pipe vitest/jest to \`grep -q\` to match "Tests N passed" — use \`npx vitest run … || exit 1\` and trust the runner exit code.
- No curl with API keys or secrets in Automated Checks.
- Shared shell regression guard: when a change reuses existing shared shell/navigation (top menubar, dashboard shell, sidebar, theme toggle), the ## Automated Checks MUST include a structural assertion that those shared components are still imported and rendered unchanged — one \`grep -q\` per token joined by \`&&\`, using the project's real component names (e.g. \`grep -q '<Menubar' src/App.tsx && grep -q 'Shell' src/App.tsx\`). Do NOT let the implementer vendor, remove, or structurally rewrite a shared shell component; only its content slots may change.
- Mock class fidelity guard: when a bound DESIGN_PACK provides element styles (componentStyles / styles.css with named classes like \`.env-pane\`, \`.card\`), the ## Automated Checks MUST assert those mock class names (or their documented ported equivalents) exist in the product source or built CSS — one \`grep -rq '<class-name>' src packages apps 2>/dev/null || grep -rq '\\.<class-name>' dist 2>/dev/null || exit 1\` per class. Utility-class approximations of mock-styled elements (bg-muted/text-muted-foreground soup replacing the mock's named classes) are a fidelity failure, not a port.`;

export type PlanningSnapshot = {
  phaseDoc: string;
  research: string;
};

export function formatPlanningGateIssuesBlock(issues: string[]): string {
  if (issues.length === 0) return "";
  return `Validation issues (fix ALL before finishing):\n${issues.map((i) => `- ${i}`).join("\n")}\n`;
}

export function buildPhaseDocRepairPrompt(opts: {
  issues: string[];
  alignIssues?: string[];
  intentIssues?: string[];
  intentBlock: string;
  canonicalPath: string;
  phaseDescription: string;
  research: string;
  preamble?: string;
}): string {
  const alignBlock =
    opts.alignIssues && opts.alignIssues.length > 0
      ? `Research alignment issues:\n${opts.alignIssues.map((i) => `- ${i}`).join("\n")}\n`
      : "";
  const intentBlockRepair =
    opts.intentIssues && opts.intentIssues.length > 0
      ? `Change Intent alignment issues (MUST fix in ## Success Criteria and ## Automated Checks — not only File Changes / Known limitations):\n${opts.intentIssues.map((i) => `- ${i}`).join("\n")}\n`
      : "";
  const preamble =
    opts.preamble ??
    "Your previous PHASE.md was invalid (chat preamble, missing sections, wrong-phase content, or Change Intent misalignment).";

  return `${preamble}
Issues:
${opts.issues.map((i) => `- ${i}`).join("\n")}
${alignBlock}${intentBlockRepair}
${opts.intentBlock}
${PLANNING_AUTOMATED_CHECKS_RULES}
Rewrite the FULL PHASE.md starting with \`# Phase …\` — output ONLY the markdown document (no "here is what changed").
If you use write_file, path must be exactly: ${opts.canonicalPath}
Required sections: ## Scope, ## File Changes, ## Success Criteria, ## Automated Checks (bash fence), ## Blueprint Deltas.
Base Scope/File Changes ONLY on the RESEARCH below — do not copy a prior phase's plan.
Obey Change Intent uiMount / interaction contract — do not substitute chips for a fillable mount.
End with PHASE_COMPLETE.

Description:
${opts.phaseDescription}
Research:
${opts.research}`;
}
