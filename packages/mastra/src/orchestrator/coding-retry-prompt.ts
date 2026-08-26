/**
 * Build develop-loop coding retry prompts from the **latest** failure diagnosis.
 * Prefer diagnosis fields over scraping the full APPENDIX (stale cards misroute).
 */

export type DevelopCodingRetryKind =
  | "deps"
  | "host-utility"
  | "long-lived"
  | "process-shell"
  | "generic";

export type DevelopCodingRetryInput = {
  phaseId: string;
  /** Latest diagnosis title / summary */
  title?: string;
  nextActions?: string;
  class?: string;
  tags?: string[];
  /**
   * Only used when no latest diagnosis title/tags are available.
   * Must not override a present diagnosis.
   */
  appendixFallback?: string;
  /**
   * Prior failure history lines (most recent first) from the per-project
   * diagnoses memory thread. Rendered above the current diagnosis so the
   * coding agent cites prior resolutions instead of re-discovering them.
   */
  priorDiagnoses?: string[];
};

export function resolveDevelopCodingRetryKind(
  input: DevelopCodingRetryInput,
): DevelopCodingRetryKind {
  const hasLatest = Boolean(
    (input.title && input.title.trim()) ||
      (input.tags && input.tags.length > 0),
  );
  const hay = hasLatest
    ? [input.title ?? "", input.nextActions ?? "", ...(input.tags ?? [])].join(
        "\n",
      )
    : (input.appendixFallback ?? "");

  if (
    /host utility|macos-portability|GNU timeout|gtimeout/i.test(hay) ||
    input.tags?.includes("host-utility")
  ) {
    // Long-lived beats stale host-utility wording when both appear in latest title
    if (
      hasLatest &&
      (input.tags?.includes("long-lived") ||
        input.tags?.includes("check-timeout") ||
        /long-lived server|CHECK_TIMEOUT|exceeded wall clock/i.test(
          input.title ?? "",
        ))
    ) {
      return "long-lived";
    }
    return "host-utility";
  }

  if (
    input.tags?.includes("long-lived") ||
    input.tags?.includes("check-timeout") ||
    /long-lived server|CHECK_TIMEOUT|exceeded wall clock|wall clock/i.test(hay)
  ) {
    return "long-lived";
  }

  if (
    /exit 127|missing deps|node_modules|tsup: command not found|vitest: command not found/i.test(
      hay,
    )
  ) {
    return "deps";
  }

  if (
    /Broken Automated Check|incomplete shell compound|shell syntax|line continuation|api-routing-complete-gate|Chat stream hang|post-merge root verify|PHASE\.md validation|Missing host utility/i.test(
      hay,
    )
  ) {
    return "process-shell";
  }

  if (input.class === "process") {
    return "process-shell";
  }

  return "generic";
}

export function buildDevelopCodingRetryPrompt(
  input: DevelopCodingRetryInput,
): string {
  const kind = resolveDevelopCodingRetryKind(input);
  const phaseId = input.phaseId;
  const next = input.nextActions?.trim()
    ? `\nDiagnosis nextActions: ${input.nextActions.trim()}`
    : "";
  const history =
    input.priorDiagnoses && input.priorDiagnoses.length > 0
      ? `Prior failure history (most recent first) — cite prior resolutions instead of re-discovering them:\n${input.priorDiagnoses
          .slice(0, 10)
          .map((line) => `- ${line}`)
          .join("\n")}\n\n`
      : "";

  const body = ((): string => {
    switch (kind) {
    case "deps":
      return `Fix the APPENDIX Failure diagnosis: **missing deps / exit 127 / command not found** in the verify cwd.
Run the project package manager install **in the worktree** (or the cwd SlopControl is verifying) — e.g. \`pnpm install --frozen-lockfile\` when \`pnpm-lock.yaml\` is present. Do NOT edit PHASE.md Automated Checks for this fingerprint. Do NOT claim DEV_COMPLETE from a green build on the project root while the worktree lacks node_modules.
Then re-run build in that same cwd. Before DEV_COMPLETE, append \`## Operator handoff\` to APPENDIX.`;
    case "host-utility":
      return `Fix the APPENDIX Failure diagnosis: **missing host utility** (e.g. GNU \`timeout\` on macOS) in an Automated Check.
Do NOT run pnpm/npm install for this fingerprint. Edit \`.slopcontrol/phases/${phaseId}/PHASE.md\` ## Automated Checks: replace \`timeout\`/\`gtimeout\` with **finite structural asserts** (grep/config) — do NOT start long-lived servers (\`pnpm dev\` / vite) and do NOT background servers with sleep/kill/wait.${next}
Then ensure root verify passes. Before DEV_COMPLETE, append \`## Operator handoff\` to APPENDIX.`;
    case "long-lived":
      return `Fix the APPENDIX Failure diagnosis: **Broken Automated Check (long-lived / hang)** — PHASE validation or wall-clock CHECK_TIMEOUT.
Do NOT run pnpm/npm install for this fingerprint. Edit \`.slopcontrol/phases/${phaseId}/PHASE.md\` ## Automated Checks: remove long-lived servers (\`pnpm/npm/yarn/bun dev|start|serve\`, vite, next dev, docker compose up) and background \`&\`+\`wait\` patterns. Use finite structural asserts (grep alias/config) or a short Node one-shot. Manual browser smoke may stay in Success Criteria — not in Automated Checks.${next}
Then ensure verify passes. Before DEV_COMPLETE, append \`## Operator handoff\` to APPENDIX.`;
    case "process-shell":
      return `Fix the APPENDIX Failure diagnosis. This is a **process** failure (PHASE.md Automated Checks and/or incomplete Ollama OpenAI-compat routing).${next}
If the diagnosis mentions Automated Checks shell/syntax: FIRST edit \`.slopcontrol/phases/${phaseId}/PHASE.md\` — rewrite the failing check into one complete statement.
If the diagnosis mentions Stream started hang or api-routing-complete-gate: implement the promised routing files (model-resolver / OLLAMA_BASE_URL / chat route) — do NOT complete on catalogue-only diffs; do NOT force free-tier.
If the diagnosis mentions post-merge root confirmation: worktree tests already passed — fix root env/sync/gitignored artifact drift; use retry_root_verify after project_env_sync when harness is the issue.
Then ensure build/tests pass. Before DEV_COMPLETE, append \`## Operator handoff\` to APPENDIX. Print DEV_COMPLETE when success criteria and Automated Checks pass.`;
    default:
      return `Fix the implementation using the latest APPENDIX Failure diagnosis.${next}
Address the **root cause of the failing step first** — do not expand scope or invent bring-up scripts.
Ensure ## Automated Checks and tests pass. Fix spawn ENOENT-style bugs by splitting command vs args.
Do NOT burn the session on live API probing or rate-limit waits — edit files and run local Automated Checks.
Do NOT chase infra bring-up (missing local services) inside the app repo — follow APPENDIX failure class.
Before DEV_COMPLETE, append \`## Operator handoff\` (Operator requirements / Knowledge / Follow-ups) to APPENDIX. Print DEV_COMPLETE when build, tests, and phase success criteria pass.`;
  }
  })();
  return `${history}${body}`;
}
