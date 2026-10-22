import type { BuildToolchainSpec } from "@slopcontrol/types";
import {
  defaultToolchainSpec,
  substituteCommandArgs,
} from "./build-toolchain.js";

/**
 * Render the Automated Checks authoring contract for one project's
 * toolchain. The INVARIANTS are language-agnostic (finite checks, targeted
 * proofs, exact tokens, trust exit codes, no infra restarts, no secret
 * curls); the VOCABULARY (dev-server examples, suite command, targeted test
 * invocation, static gate) renders from the resolved BuildToolchainSpec so a
 * Rust/Go/Python project never sees node-estate commands.
 */
export function renderAutomatedChecksRules(opts?: {
  toolchain?: BuildToolchainSpec | null;
  /** True when SlopControl verify brings up backing services for this project. */
  hasTestServices?: boolean;
}): string {
  const spec = opts?.toolchain ?? defaultToolchainSpec("node-pnpm");
  const kind = spec?.kind ?? "node-pnpm";
  const isNode = kind.startsWith("node");
  const hasServices = opts?.hasTestServices ?? true;

  const devServerExamples = isNode
    ? "`next dev`, `pnpm dev`"
    : kind === "rust-cargo"
      ? "`cargo run`"
      : kind === "go"
        ? "`go run`"
        : kind === "python"
          ? "`flask run`, `uvicorn --reload`"
          : null;

  // Example ref shape for the targeted-test template, per ecosystem.
  const refExample = isNode
    ? "<file>"
    : kind === "rust-cargo"
      ? "<test_name>"
      : kind === "go"
        ? "<NameRegex>"
        : kind === "python"
          ? "<file>::<test_name>"
          : "<ref>";
  const targeted = spec?.targetedTestCmd
    ? substituteCommandArgs(spec.targetedTestCmd, { ref: refExample }).join(" ")
    : null;
  const suiteCmd = spec?.testCmd?.join(" ") ?? null;
  const typecheck = spec?.typecheckCmd?.join(" ") ?? null;
  const runnerName = isNode
    ? "vitest/jest"
    : kind === "rust-cargo"
      ? "cargo test"
      : kind === "go"
        ? "go test"
        : kind === "python"
          ? "pytest"
          : "the test runner";

  const lines: string[] = [
    "## Automated Checks rules (MUST obey on every PHASE.md write)",
    "- One fenced cell per process (```bash / ```typescript / `lang cmd=…`).",
    `- Checks must be finite: ${devServerExamples ? `no dev servers (${devServerExamples}), ` : "no long-lived dev servers, "}no bare \`docker compose up\`.`,
  ];
  if (hasServices) {
    lines.push(
      `- Runtime probes must not restart infra: SlopControl verify already brings up test-services (Postgres/Redis/…). Do NOT \`docker compose up\` any service and do NOT add \`trap 'docker compose down' EXIT\` in checks. ${
        isNode
          ? "DB-dependent checks assume services are up: `export DATABASE_URL=… && pnpm db:migrate && pnpm seed && npx vitest run <file>`; app-runtime proofs use build/typecheck or a short Node one-shot."
          : "DB-dependent checks assume services are up (migrate/seed via the project's own commands, then a targeted test); app-runtime proofs use the static build/check gate or a short one-shot script."
      }`,
    );
  } else {
    lines.push(
      "- Runtime probes must be finite and self-contained: bring up only the service you probe (`docker compose up -d <svc>` plus `trap 'docker compose down' EXIT`), probe it, and tear it down.",
    );
  }
  lines.push(
    "- Static proofs use `grep -q` per token joined by `&&` — never same-line `.*` chains.",
    "- Fixed-token grep: when the token is a fixed substring, use plain `grep -q 'fixed-substring'` (not `grep -qE` with a regex group/alternation like `export (function|const) resolveRoute`). Reserved regex (alternation) is only for genuinely-variant tokens.",
  );
  if (isNode) {
    lines.push(
      "- No bare `npm test` / `pnpm test` without a targeted path — prove the phase's change with `npx vitest run <file> || exit 1` or `npm test -- <path>`, not the whole suite.",
    );
  } else if (suiteCmd || targeted) {
    lines.push(
      `- No bare \`${suiteCmd ?? "test suite"}\` without a targeted ref — prove the phase's change with \`${targeted ?? "<targeted test command>"} || exit 1\`, not the whole suite.`,
    );
  }
  lines.push(
    "- Exact JSON token: grep the exact quoted token that exists on disk (e.g. `grep -q '\"version\": 2'`), never an unquoted approximation RESEARCH only loosely names.",
  );
  lines.push(
    `- Never pipe ${runnerName} to \`grep -q\` to match "Tests N passed" — use \`${isNode ? "npx vitest run …" : (targeted ?? "<targeted test command>")} || exit 1\` and trust the runner exit code.`,
  );
  if (typecheck) {
    lines.push(
      `- Static type/compile gate: \`${typecheck}\` is the cheap total proof — prefer it over grep for "still compiles / types line up" claims.`,
    );
  }
  lines.push("- No curl with API keys or secrets in Automated Checks.");
  // UI guards reference the project's shell components and design-pack mock
  // classes — design-verify is currently JS-web-only, so render them for
  // node ecosystems only (never leak estate vocabulary into rust/go/python).
  if (isNode) {
    lines.push(
      "- Shared shell regression guard: when a change reuses existing shared shell/navigation (top menubar, dashboard shell, sidebar, theme toggle), the ## Automated Checks MUST include a structural assertion that those shared components are still imported and rendered unchanged — one `grep -q` per token joined by `&&`, using the project's real component names (e.g. `grep -q '<Menubar' src/App.tsx && grep -q 'Shell' src/App.tsx`). Do NOT let the implementer vendor, remove, or structurally rewrite a shared shell component; only its content slots may change.",
      "- Mock class fidelity guard: when a bound DESIGN_PACK provides element styles (componentStyles / styles.css with named classes like `.env-pane`, `.card`), the ## Automated Checks MUST assert those mock class names (or their documented ported equivalents) exist in the product source or built CSS — one `grep -rq '<class-name>' src packages apps 2>/dev/null || grep -rq '\\.<class-name>' dist 2>/dev/null || exit 1` per class. Utility-class approximations of mock-styled elements (bg-muted/text-muted-foreground soup replacing the mock's named classes) are a fidelity failure, not a port.",
    );
  }
  return lines.join("\n");
}

/** Shared prompt contract for draft, review revision, and repair agents. */
export const PLANNING_AUTOMATED_CHECKS_RULES = renderAutomatedChecksRules();

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
  /** Toolchain-rendered checks contract (defaults to the node-default rules). */
  checkRules?: string;
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
${opts.checkRules ?? PLANNING_AUTOMATED_CHECKS_RULES}
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
