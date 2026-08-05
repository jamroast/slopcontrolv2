import { createHash } from "node:crypto";
import type { LearningCandidate } from "./learnings.js";
import type { LearningKind, LearningSeverity } from "@slopcontrol/types";
import { redactSecrets } from "./redact-secrets.js";

export type FailureClass =
  | "infra"
  | "product"
  | "process"
  | "model"
  | "env"
  | "unknown";

export type ClassifiedFailure = {
  class: FailureClass;
  confidence: "high" | "medium" | "low";
  summary: string;
  tags: string[];
  /** Durable lesson candidate (when confidence is not low). */
  learning?: LearningCandidate;
  /** Infra failures should not be "fixed" by the coding agent rewriting app code. */
  codingAgentShouldFix: boolean;
  /** Who should act on this failure. */
  audience: "operator" | "coding";
  /** Concrete operator steps (keys, services, sync) — empty when coding should fix. */
  operatorActions: string[];
};

export type VerifyFailureStep = {
  name: string;
  command?: string;
  exitCode: number;
  output: string;
};

/** Host OS utilities that are not cured by pnpm/npm install. */
const HOST_UTILITY_CMDS = new Set([
  "timeout",
  "gtimeout",
  "timeout.exe",
  "watch",
  "column",
  "stdbuf",
  "flock",
  "unbuffer",
  "script",
]);

/** Typical node_modules /.bin names — missing → reinstall deps. */
const NODE_BIN_CMDS = new Set([
  "vitest",
  "tsup",
  "eslint",
  "jest",
  "tsc",
  "vite",
  "next",
  "tsx",
  "webpack",
  "rollup",
  "prettier",
  "turbo",
  "nodemon",
  "mocha",
  "ava",
  "playwright",
  "cypress",
]);

export type MissingCommandKind = "host-utility" | "node-bin" | "unknown";

export type MissingCommandClassification = {
  kind: MissingCommandKind;
  command: string | null;
};

/** Extract `cmd` from `cmd: command not found` / `sh: cmd: command not found`. */
export function extractMissingCommand(text: string): string | null {
  const raw = text ?? "";
  const bashLine = raw.match(
    /line\s+\d+:\s*([A-Za-z0-9._+-]+):\s*command not found/i,
  );
  if (bashLine?.[1]) return bashLine[1].toLowerCase();
  const m = raw.match(
    /(?:^|\n)\s*(?:sh:\s*)?([A-Za-z0-9._+-]+):\s*command not found/i,
  );
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Classify a command-not-found failure as host utility vs package bin.
 * Used by diagnosis and auto deps-install so they stay aligned.
 */
export function classifyMissingCommand(
  stepCtx: string,
  opts?: { exitCode?: number; stepName?: string },
): MissingCommandClassification {
  const command = extractMissingCommand(stepCtx);
  if (command && HOST_UTILITY_CMDS.has(command)) {
    return { kind: "host-utility", command };
  }
  if (command && NODE_BIN_CMDS.has(command)) {
    return { kind: "node-bin", command };
  }
  if (
    /\b(timeout|gtimeout|stdbuf|flock)\b.{0,40}command not found|command not found.{0,40}\b(timeout|gtimeout)\b/i.test(
      stepCtx,
    )
  ) {
    const inferred =
      command ??
      (/\bgtimeout\b/i.test(stepCtx) ? "gtimeout" : "timeout");
    return { kind: "host-utility", command: inferred };
  }
  if (
    opts?.exitCode === 127 ||
    /command not found|not found \(exit 127\)/i.test(stepCtx)
  ) {
    return { kind: "node-bin", command };
  }
  return { kind: "unknown", command };
}

/** True when auto deps-install should run (missing package bin, not host utility). */
export function isMissingNodeBinFailure(step: {
  name?: string;
  command?: string;
  exitCode?: number;
  output?: string;
}): boolean {
  const stepCtx = [step.name ?? "", step.command ?? "", step.output ?? ""].join(
    "\n",
  );
  if (
    !/command not found|not found \(exit 127\)/i.test(stepCtx) &&
    step.exitCode !== 127
  ) {
    return false;
  }
  const classified = classifyMissingCommand(stepCtx, {
    exitCode: step.exitCode,
    stepName: step.name,
  });
  return classified.kind === "node-bin";
}

export type FailureDiagnosis = {
  class: FailureClass;
  confidence: "high" | "medium" | "low";
  title: string;
  rootCause: string;
  evidence: string;
  nextActions: string;
  fingerprint: string;
  codingAgentShouldFix: boolean;
  audience: "operator" | "coding";
  operatorActions: string[];
  /** Classifier tags (e.g. long-lived, host-utility) for retry routing. */
  tags?: string[];
  learning?: LearningCandidate;
  failingStep?: {
    name: string;
    command?: string;
    exitCode: number;
    stepId?: string;
  };
};

/**
 * Classify verify/check failure text into infra vs product vs env/model/process.
 *
 * Prefer calling with the **first failing step** output (via buildFailureDiagnosis),
 * not a truncated whole-run blob — incidental dotenv tips must not become `env`.
 */
export function classifyVerifyFailure(
  output: string,
  opts?: {
    sourcePhaseId?: string;
    sourceRunId?: string;
    stepName?: string;
    command?: string;
    exitCode?: number;
  },
): ClassifiedFailure {
  const text = output ?? "";
  const stepCtx = [opts?.stepName ?? "", opts?.command ?? "", text].join("\n");
  const lower = stepCtx.toLowerCase();

  // Host OS utilities (e.g. GNU timeout on macOS) — not cured by pnpm install
  const missingCmd = classifyMissingCommand(stepCtx, {
    exitCode: opts?.exitCode,
    stepName: opts?.stepName,
  });
  if (missingCmd.kind === "host-utility") {
    const util = missingCmd.command ?? "utility";
    return build(
      "process",
      "high",
      `Missing host utility in Automated Check (\`${util}\`)`,
      ["automated-checks", "host-utility", "macos-portability"],
      {
        codingAgentShouldFix: true,
        lesson: `Automated Check invoked host utility \`${util}\`, which is not available on this OS (macOS has no GNU timeout by default). Rewrite PHASE.md ## Automated Checks to finite structural asserts (grep/config) — do NOT start long-lived servers (\`pnpm dev\` / vite) and do NOT run pnpm/npm install for this fingerprint.`,
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // Per-check wall-clock budget exceeded (long-lived server / hung wait)
  if (/CHECK_TIMEOUT\b/i.test(stepCtx)) {
    return build(
      "process",
      "high",
      "Broken Automated Check (exceeded wall clock)",
      ["automated-checks", "check-timeout", "long-lived"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Automated Check exceeded SlopControl wall-clock budget (CHECK_TIMEOUT). Remove long-lived servers (`pnpm dev` / vite / docker compose up) and background `&`+`wait` patterns. Prefer finite structural asserts in PHASE.md ## Automated Checks.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // Missing package bin / node_modules (exit 127) — install deps, do not invent app fixes
  if (
    missingCmd.kind === "node-bin" ||
    opts?.exitCode === 127 ||
    /command not found|not found \(exit 127\)|ENOENT.*spawn|no such file or directory.*bin\//i.test(
      stepCtx,
    )
  ) {
    return build(
      "process",
      "high",
      "Command not found (exit 127) — missing deps or PATH",
      ["deps", "node-modules", "exit-127"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Exit 127 / command not found usually means node_modules is missing in a fresh worktree (vitest/eslint not on PATH). Run `npm ci` or `npm install` in the verify cwd, or ensure package.json scripts use `npx`/local bins. Do not rewrite product code to paper over missing installs.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // Unresolved packages (Vitest/Vite/Node) — stale or incomplete node_modules
  if (
    /Failed to load url\b|Cannot find module\b|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find package\b/i.test(
      stepCtx,
    )
  ) {
    return build(
      "process",
      "high",
      "Missing or unresolved node dependency",
      ["deps", "node-modules", "module-not-found"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Vitest/Node could not resolve a package (Failed to load url / Cannot find module). Reinstall deps in the **verify cwd** with the project package manager (pnpm install --frozen-lockfile, yarn install --frozen-lockfile, or npm ci). After a merge, install must run on the project root — worktree installs do not fix the root gate. Do not rewrite product code to paper over missing installs.",
        evidence: stepCtx.slice(-800),
        opts,
      },
    );
  }

  // Shell / phase-doc process failures (broken Automated Checks)
  if (
    /syntax error: unexpected end of file|syntax error near|unexpected eof|broken automated check ends with/i.test(
      stepCtx,
    ) ||
    (opts?.command && /\\\s*$/.test(opts.command.trim()))
  ) {
    return build(
      "process",
      "high",
      "Broken Automated Check (shell syntax / line continuation)",
      ["automated-checks", "shell-syntax"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Automated Checks must be complete shell commands. Never leave a trailing `\\` continuation — put the full command on one line (or ensure continuations are joined). Fix PHASE.md ## Automated Checks, then re-run.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // echo "VAR=$?" prints but does not assign — test "$VAR" sees empty → integer expression expected
  if (
    /integer expression expected|unary operator expected|test:\s*:/i.test(
      stepCtx,
    ) ||
    (/echo\s+["'][A-Z_][A-Z0-9_]*=\$\?["']/i.test(stepCtx) &&
      /test\s+"?\$[A-Z_][A-Z0-9_]*"?\s+-eq/i.test(stepCtx))
  ) {
    return build(
      "process",
      "high",
      "Broken Automated Check (empty test / exit-code capture)",
      ["automated-checks", "shell-syntax", "exit-capture"],
      {
        codingAgentShouldFix: true,
        lesson:
          'Do not use `echo "VAR=$?"` — that prints but does not assign. Prefer `cmd || exit 1`, or `VAR=$?` then `test "$VAR" -eq 0`. Fix PHASE.md ## Automated Checks, then re-run.',
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // Empty-var RC-DEADLOCK / split-cell false positive (assignments ran in separate shells)
  if (
    /RC-DEADLOCK/i.test(stepCtx) &&
    (/AI_CHAT_MODEL=\s*==\s*AI_CODE_MODEL=/i.test(stepCtx) ||
      /AI_CHAT_MODEL=\s*$/m.test(stepCtx) ||
      /=\s*==\s*/.test(stepCtx))
  ) {
    return build(
      "process",
      "high",
      "Broken Automated Check (empty vars / cell split)",
      ["automated-checks", "check-cell", "rc-deadlock"],
      {
        codingAgentShouldFix: true,
        lesson:
          "One markdown fence = one check cell (shared process/env). Put assignments and the assertion that uses them in the SAME ```bash (or other language) fence. Separate fences do not share shell variables. Fix PHASE.md ## Automated Checks, then re-run.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // Incomplete removal of embedded Ollama / dead-container refs
  if (
    /FAIL:\s*embedded ollama/i.test(stepCtx) ||
    /dead-container reference remains/i.test(stepCtx) ||
    (/embedded ollama/i.test(stepCtx) &&
      /http:\/\/ollama:11434|11435:11434|ollama-init/i.test(stepCtx))
  ) {
    return build(
      "process",
      "high",
      "Embedded Ollama / dead-container references remain",
      ["docker", "ollama", "dead-container", "automated-checks"],
      {
        codingAgentShouldFix: true,
        lesson:
          "When PHASE removes the embedded jamjar-ollama stack, purge compose services AND test fixtures that still assert http://ollama:11434, 11435:11434, ollama-init, or compose OLLAMA_TIER=free. Finish those edits per PHASE.md — do not leave unclassified verify noise.",
        evidence: stepCtx.slice(-800),
        opts,
      },
    );
  }

  // Placeholder host leaked into runtime env (examples may use your-box-ip; runtime must not)
  if (
    /your-box-ip/i.test(stepCtx) &&
    (/\.env\.docker(?!\.example)|\.env\.local|runtime/i.test(stepCtx) ||
      /OLLAMA_BASE_URL=http:\/\/your-box-ip/i.test(stepCtx))
  ) {
    return build(
      "process",
      "high",
      "Placeholder host (your-box-ip) in runtime env",
      ["env", "placeholder", "ollama"],
      {
        codingAgentShouldFix: true,
        lesson:
          ".env.example / .env.docker.example may use placeholders like your-box-ip. Runtime .env.docker / .env.local must use a real host (LAN IP or localhost). Automated Checks that grep placeholders belong on *.example files only.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // Chat hangs after Stream started (OpenAI-compat stream+tools / wrong host+ID)
  if (
    (/\[chat\]\s*Stream started/i.test(stepCtx) &&
      !/\[chat\]\s*Stream ended/i.test(stepCtx) &&
      !/AI_APICallError|statusCode:\s*4\d\d/i.test(stepCtx)) ||
    (/stream started/i.test(stepCtx) &&
      /toolCount:\s*[1-9]/i.test(stepCtx) &&
      /(hang|thinking…|thinking\.\.\.|no tokens|silence|stall)/i.test(
        stepCtx,
      )) ||
    /api-routing-complete-gate|catalogue\/docs\/tests-only merges/i.test(
      stepCtx,
    )
  ) {
    return build(
      "process",
      "high",
      "Chat stream hang / incomplete Ollama OpenAI-compat routing phase",
      ["ollama", "openai-compatible", "chat-stream", "tools"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Chat hanging after `[chat] Stream started` (often with toolCount>0) is usually OpenAI-compat stream+tools fragility or wrong OLLAMA_BASE_URL / model ID pairing — not free-tier. Remember: ollama.com/v1 + paid → bare IDs; api.ollama.cloud/v1 often needs :cloud. Do not mark API-routing phases complete on catalogue-only diffs or npm test alone. Fix PHASE.md + the promised routing files (model-resolver, env URL, chat route), then re-run.",
        evidence: stepCtx.slice(-800),
        opts,
      },
    );
  }

  // Automated Check grep/.env assertions — often match comments (:cloud), not LLM quota
  const stepIsAutomatedCheck = /^automatedcheck$/i.test(opts?.stepName ?? "");
  const cmd = opts?.command ?? "";
  if (
    stepIsAutomatedCheck &&
    /grep/i.test(cmd) &&
    /\.env/i.test(cmd)
  ) {
    return build(
      "process",
      "high",
      "Broken Automated Check (env grep matches comments or wrong pattern)",
      ["automated-checks", "env-grep"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Automated Checks that grep `.env*` must not match comment lines. Prefer assignment-only patterns (e.g. `grep -E '^[^#]*:cloud' .env.docker` or `grep -E '^(AI_.*MODEL|OLLAMA_TIER)=' .env.docker`). Fix PHASE.md ## Automated Checks and/or remove the substring from comments — do not treat this as LLM key/quota infra.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // Model / LLM entitlement / quota — infra for develop gates; do not free-tier-swap
  // Keep smoke/entitlement signals only — bare "subscription" / "paid tier" match .env comments.
  if (
    /ollama cloud model ids missing|model entitlement 403|chat smoke failed|paid subscription required|http 429|weekly usage limit|rate limit/i.test(
      stepCtx,
    )
  ) {
    return build("infra", "high", "LLM endpoint / entitlement / quota (use local test profile)", [
      "ollama",
      "model",
      "llm-test-harness",
    ], {
      codingAgentShouldFix: false,
      lesson:
        "Verify/tests must use SlopControl llmTestProfile=local (or fixture) with process.env / .env.test — never fall back to free-tier Ollama Cloud or switch product models to free-tier IDs. Operator: start local Ollama or set pipeline OLLAMA_* vars; set llmSmokeMode=off for develop gates.",
      evidence: stepCtx.slice(-600),
      opts,
    });
  }

  // Free-tier / model-size failures when still on cloud free tier
  if (
    /model.*(not found|too large|does not exist)|context length|context window|free.?tier/i.test(
      stepCtx,
    ) &&
    /ollama|llm|ai_chat_model|glm|minimax/i.test(stepCtx)
  ) {
    return build("infra", "high", "LLM model unavailable (likely free-tier cloud fallback)", [
      "ollama",
      "model-size",
      "llm-test-harness",
    ], {
      codingAgentShouldFix: false,
      lesson:
        "Tests hit a model that is missing or too small (often free-tier Ollama Cloud). Point verify at local Ollama via llmTestProfile=local + llmModelMap, or fixture profile. Do not edit .env.docker to free-tier models.",
      evidence: stepCtx.slice(-600),
      opts,
    });
  }

  // Env / secrets — operator must supply real env (not worktree-only product hacks)
  const envHit =
    /enoent.*\.env|no such file or directory:.*\.env|missing (required )?(env|environment|\.env)|api[_ ]?key.*(missing|undefined|empty|not set)|cannot find .*?\.env/i.test(
      stepCtx,
    ) && !/injected env|◇ injected env|tip:.*dotenv/i.test(stepCtx);

  if (
    envHit ||
    (/PHASE\.md validation failed/i.test(stepCtx) &&
      /env|\.env/i.test(stepCtx) &&
      /missing/i.test(stepCtx))
  ) {
    return build("env", "high", "Missing or incomplete environment / secrets files", [
      "env",
      "secrets",
    ], {
      codingAgentShouldFix: false,
      lesson:
        "Env files (.env, .env.docker, .env.local, .env.test) must exist on the project root like CI/runtime. SlopControl syncs them into the worktree and writes .env.slopcontrol. Prefer process.env / pipeline vars. Do not invent worktree-only product fixes.",
      evidence: stepCtx.slice(-600),
      opts,
    });
  }

  // Soft-fail automated checks
  if (
    /printed fail|prefer `\|\| exit 1`|automated check printed fail/i.test(stepCtx)
  ) {
    return build(
      "process",
      "high",
      "Automated Checks soft-fail (echo FAIL exits 0)",
      ["automated-checks", "soft-fail"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Automated Checks must fail the shell on failure (`|| exit 1`). Never use `|| echo FAIL` — exit code stays 0 and hides failures.",
        evidence: stepCtx.slice(-400),
        opts,
      },
    );
  }

  // Preflight / verifyPreflight infra
  if (/verifypreflightcommand failed|runtime dependency not ready/i.test(stepCtx)) {
    return build(
      "infra",
      "high",
      "Runtime dependency unavailable (preflight)",
      ["infra", "preflight", "runtime-dependency"],
      {
        codingAgentShouldFix: false,
        lesson:
          "verifyPreflightCommand failed — restore the project's required runtime services, then retry. Do not invent app bring-up scripts in the coding loop.",
        evidence: stepCtx.slice(-800),
        opts,
        severity: "blocker",
      },
    );
  }

  // Worktree isolation port leaked into root verify (expected product port vs 55xx)
  {
    const expectedMatch = stepCtx.match(
      /(?:Expected|to be|toEqual)[:\s]*["'`]?[^"'`\n]*:(\d{2,5})\b/i,
    );
    const receivedMatch = stepCtx.match(
      /(?:Received|got)[:\s]*["'`]?[^"'`\n]*:(\d{2,5})\b/i,
    );
    const expectedPort = expectedMatch ? Number(expectedMatch[1]) : NaN;
    const receivedPort = receivedMatch ? Number(receivedMatch[1]) : NaN;
    const isolationSkew =
      Number.isFinite(expectedPort) &&
      Number.isFinite(receivedPort) &&
      expectedPort > 0 &&
      receivedPort >= 5500 &&
      receivedPort <= 5599 &&
      expectedPort !== receivedPort &&
      /localhost|postgres|database_url|db_port|jamlite/i.test(stepCtx);
    const isolationHint =
      /DB_PORT=55\d{2}|localhost:55\d{2}|COMPOSE_PROJECT_NAME=slopwt-/i.test(
        stepCtx,
      ) &&
      /AssertionError|expected .* to (?:be|equal|match)|localhost:54\d{2}/i.test(
        stepCtx,
      );
    if (isolationSkew || isolationHint) {
      return build(
        "process",
        "high",
        "Worktree DB port isolation leaked into root verify",
        ["process", "env-isolation", "db-port", "slopcontrol"],
        {
          codingAgentShouldFix: false,
          lesson:
            "Root verify saw a worktree isolation host port (5500–5599) while product tests assert the canonical published port. This is a SlopControl env-isolation leak — restore canonical runtime env / scrub isolation keys and retry_development. Do not hardcode the isolation port into product code or weaken port contract tests.",
          evidence: stepCtx.slice(-800),
          opts,
          severity: "blocker",
          operatorActions: [
            "Retry development after SlopControl restores canonical DB_PORT from `.slopcontrol/canonical-runtime-env.json` (or restart the SlopControl server with the isolation-heal build).",
            "Do not change product tests to expect ports in 5500–5599.",
          ],
        },
      );
    }
  }

  // Host port already bound (often leftover worktree compose) — operator infra, not app code
  if (
    /port is already allocated|bind for 0\.0\.0\.0:\d+ failed|address already in use|eaddrinuse/i.test(
      stepCtx,
    )
  ) {
    const portMatch = stepCtx.match(
      /(?:0\.0\.0\.0:|bind.*?:|port\s+)(\d{2,5})/i,
    );
    const port = portMatch?.[1];
    return build(
      "infra",
      "high",
      port
        ? `Host port ${port} already allocated (Docker/bind conflict)`
        : "Host port already allocated (Docker/bind conflict)",
      ["infra", "docker", "port-conflict", ...inferServiceTags(lower)],
      {
        codingAgentShouldFix: false,
        lesson:
          "docker compose (or another process) could not bind a published host port because it is already allocated — often a leftover phase worktree compose stack. Free the port (docker compose down in the worktree / stop the holding container), then retry_development. Do not change the product DB port or rewrite Automated Checks to paper over the conflict.",
        evidence: stepCtx.slice(-800),
        opts,
        severity: "blocker",
        operatorActions: [
          port
            ? `Identify what holds host port ${port} (\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` or \`docker ps\`).`
            : "Identify the process/container holding the published host port (`lsof` / `docker ps`).",
          "Tear down leftover phase worktree compose (`docker compose down` in that worktree) or stop the conflicting container.",
          "Confirm the port is free, then call retry_development (do not change the app's published port).",
        ],
      },
    );
  }

  // Generic infra
  const infraHit =
    /econnrefused|enotfound|ehostunreach|etimedout|connection refused|could not connect|connect econnrefused|no such host|docker.*(?:daemon|not running|cannot connect)|compose.*(?:not running|exited)|waiting for .*?(?:ready|healthy)|port \d+.*(refused|unreachable)/i.test(
      stepCtx,
    ) || /error:\s*connect\s+econnrefused/i.test(stepCtx);

  // Ignore "connection refused" inside mocked test names / expected graceful-degradation logs
  // when the failing step is clearly a unit test that passed framing — only treat as infra
  // when the step itself failed with that signal (caller passes firstFailure only).
  if (infraHit && !/graceful degradation|failed to connect to \w+: error: connection refused\s*\n\s*at .*test/i.test(lower)) {
    const serviceHint = inferServiceTags(lower);
    return build(
      "infra",
      "high",
      "Runtime dependency unavailable (infra)",
      ["infra", "runtime-dependency", ...serviceHint],
      {
        codingAgentShouldFix: false,
        lesson:
          "Verify failures that show connection refused / unreachable hosts / stopped containers are infrastructure — not application bugs. Bring the required runtime services up (or set verifyPreflightCommand) before re-running tests. Do not invent app-repo scripts to paper over missing local services, and do not burn coding iterations on env bring-up.",
        evidence: stepCtx.slice(-800),
        opts,
        severity: "blocker",
      },
    );
  }

  // Merge blocked by dirty/untracked .slopcontrol (not a real conflict) —
  // SlopControl should auto-clear; do not treat as operator-only infra.
  if (
    /Merge blocked by dirty\/untracked|would be overwritten by merge|Please move or remove them before you merge/i.test(
      stepCtx,
    )
  ) {
    return build(
      "process",
      "high",
      "Merge blocked by dirty/untracked .slopcontrol paths",
      ["git", "merge", "slopcontrol-overwrite"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Git refused the phase merge because untracked or modified `.slopcontrol/**` on the project root would be overwritten. SlopControl clears those blockers before merge; retry development so auto-merge can complete. Do not rewrite product code for this.",
        evidence: stepCtx.slice(-800),
        opts,
      },
    );
  }

  // Successful merge that left a pre-merge stash unrestored — operator git hygiene,
  // not a product verify failure for the coding agent.
  if (
    /unrestored pre-merge stash|Pre-merge stash kept|Restore or drop the pre-merge stash/i.test(
      stepCtx,
    )
  ) {
    return build(
      "process",
      "high",
      "Pre-merge stash left unrestored after successful merge",
      ["git", "merge", "stash"],
      {
        codingAgentShouldFix: false,
        lesson:
          "Auto-merge into the target branch succeeded, but the pre-merge stash was not restored. Restore or drop it (git stash pop / git stash drop, or MCP resolve_conflicts) before continuing. Do not rewrite product code for this.",
        evidence: stepCtx.slice(-800),
        opts,
        operatorActions: [
          "Inspect `git stash list` in the project root.",
          "Restore with `git stash pop` (or MCP resolve_conflicts), or `git stash drop` if the stash is redundant.",
          "Then call retry_development / continue the phase.",
        ],
      },
    );
  }

  // True merge / git process conflicts
  if (/auto-merge failed|merge conflict|merge aborted/i.test(stepCtx)) {
    return build("process", "high", "Git merge / worktree process failure", [
      "git",
      "merge",
    ], {
      codingAgentShouldFix: false,
      lesson:
        "Real merge conflicts need resolve_conflicts (strategy=phase) or MCP merge_phase — not more feature code in the worktree.",
      evidence: stepCtx.slice(-500),
      opts,
    });
  }

  // PHASE validation — long-lived server / bg+wait (before generic phase-doc)
  if (
    /phase\.md validation failed|broken automated check/i.test(stepCtx) &&
    /long-lived server|backgrounds a process|do not background servers/i.test(
      stepCtx,
    )
  ) {
    return build(
      "process",
      "high",
      "Broken Automated Check (long-lived server)",
      ["automated-checks", "long-lived", "phase-doc"],
      {
        codingAgentShouldFix: true,
        lesson:
          "PHASE.md ## Automated Checks must be finite. Remove long-lived servers (`pnpm/npm/yarn/bun dev|start|serve`, vite, next dev, docker compose up) and background `&`+`wait`. Prefer structural asserts (grep alias/config) or a short Node one-shot.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // PHASE validation — GNU timeout rejected at validate (align with host-utility rewrite)
  if (
    /phase\.md validation failed|broken automated check/i.test(stepCtx) &&
    /GNU `timeout`|gtimeout|not available on macOS/i.test(stepCtx)
  ) {
    return build(
      "process",
      "high",
      "Broken Automated Check (GNU timeout / host utility)",
      ["automated-checks", "host-utility", "macos-portability", "phase-doc"],
      {
        codingAgentShouldFix: true,
        lesson:
          "Automated Check used GNU `timeout`/`gtimeout`, which is not available on macOS by default. Rewrite PHASE.md ## Automated Checks to finite structural asserts (grep/config) — do NOT start long-lived servers and do NOT background `pnpm dev` with sleep/kill/wait.",
        evidence: stepCtx.slice(-600),
        opts,
      },
    );
  }

  // PHASE validation / process (generic)
  if (/phase\.md validation failed|broken automated check/i.test(stepCtx)) {
    return build("process", "high", "PHASE.md validation / Automated Checks process failure", [
      "phase-doc",
      "process",
    ], {
      codingAgentShouldFix: true,
      lesson:
        "Fix PHASE.md structure or Automated Checks so they are valid runnable commands, then continue development.",
      evidence: stepCtx.slice(-600),
      opts,
    });
  }

  // Lint errors (not warnings-only noise when exit non-zero with error count)
  if (
    /\d+ error[s]?\b|eslint.*error|npm run lint|✖ \d+ problems \(\d+ errors/i.test(
      stepCtx,
    )
  ) {
    return build("product", "medium", "Lint or static analysis failure", [
      "product",
      "lint",
    ], {
      codingAgentShouldFix: true,
      lesson:
        "Fix lint/static-analysis failures reported by Automated Checks. Warnings alone are not env issues.",
      evidence: stepCtx.slice(-600),
      opts,
      severity: "warning",
    });
  }

  // Build / type / test assertion failures → product
  if (
    /build failed|error ts\d+|typeerror|assertionerror|fail(ed|ing)? tests|tests? failed|expected .* received|failing\s+\d+/i.test(
      stepCtx,
    )
  ) {
    return build("product", "medium", "Build, typecheck, or test assertion failure", [
      "product",
      "tests",
    ], {
      codingAgentShouldFix: true,
      lesson:
        "Fix the failing build/tests in the worktree per PHASE.md. Prefer targeted Automated Checks over rewriting unrelated modules.",
      evidence: stepCtx.slice(-600),
      opts,
      severity: "warning",
    });
  }

  return {
    class: "unknown",
    confidence: "low",
    summary: "Unclassified verify failure",
    tags: ["unknown"],
    codingAgentShouldFix: true,
    audience: "coding",
    operatorActions: [],
  };
}

/**
 * Build a durable diagnosis card from the first failing verify step.
 * This is the primary signal for the diagnose-then-act loop.
 */
export function buildFailureDiagnosis(input: {
  output: string;
  firstFailure?: VerifyFailureStep;
  /** Stable id matching verify_steps[].id when already assigned. */
  failingStepId?: string;
  sourcePhaseId?: string;
  sourceRunId?: string;
}): FailureDiagnosis {
  const step = input.firstFailure;
  const classifyText = step
    ? [step.name, step.command ?? "", step.output].join("\n")
    : input.output;

  const classified = classifyVerifyFailure(classifyText, {
    sourcePhaseId: input.sourcePhaseId,
    sourceRunId: input.sourceRunId,
    stepName: step?.name,
    command: step?.command,
    exitCode: step?.exitCode,
  });

  const evidence = redactSecrets(lastLines(step?.output ?? input.output, 40));
  const rootCause = step
    ? `${step.name}${step.command ? ` (\`${truncate(step.command, 120)}\`)` : ""} exited ${step.exitCode}: ${classified.summary}`
    : classified.summary;

  const nextActions = nextActionsFor(classified, step);

  const fingerprint = createHash("sha256")
    .update(
      [
        classified.class,
        step?.name ?? "",
        step?.command ?? "",
        String(step?.exitCode ?? ""),
        classified.summary,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);

  const stepId =
    input.failingStepId?.trim() ||
    (step
      ? step.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 64) || "step"
      : undefined);

  return {
    class: classified.class,
    confidence: classified.confidence,
    title: classified.summary,
    rootCause,
    evidence,
    nextActions,
    fingerprint,
    codingAgentShouldFix: classified.codingAgentShouldFix,
    audience: classified.audience,
    operatorActions: classified.operatorActions,
    tags: classified.tags,
    learning: classified.learning,
    failingStep: step
      ? {
          name: step.name,
          command: step.command,
          exitCode: step.exitCode,
          stepId,
        }
      : undefined,
  };
}

/** Markdown card for APPENDIX / prompts. Secrets are redacted from evidence. */
export function formatDiagnosisCard(d: FailureDiagnosis): string {
  const evidence = redactSecrets(d.evidence).slice(0, 2000);
  return [
    "## Failure diagnosis",
    "",
    `- **class:** ${d.class} (${d.confidence})`,
    `- **audience:** ${d.audience}`,
    `- **title:** ${d.title}`,
    `- **coding agent should fix:** ${d.codingAgentShouldFix}`,
    d.failingStep
      ? `- **failing step:** ${d.failingStep.name}${d.failingStep.command ? ` — \`${truncate(d.failingStep.command, 100)}\`` : ""} (exit ${d.failingStep.exitCode})`
      : null,
    `- **fingerprint:** \`${d.fingerprint}\``,
    "",
    "### Root cause",
    "",
    d.rootCause,
    "",
    "### Evidence (failing step tail)",
    "",
    "```",
    evidence,
    "```",
    "",
    d.operatorActions.length > 0 ? "### Operator actions" : null,
    d.operatorActions.length > 0 ? "" : null,
    ...d.operatorActions.map((a, i) => `${i + 1}. ${a}`),
    d.operatorActions.length > 0 ? "" : null,
    "### Next actions",
    "",
    d.nextActions,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function nextActionsFor(
  classified: ClassifiedFailure,
  step?: VerifyFailureStep,
): string {
  if (classified.class === "infra") {
    return "Operator: restore runtime dependencies (or fix verifyPreflightCommand), then retry_development. Coding agent: do not invent bring-up scripts.";
  }
  if (
    classified.class === "process" &&
    (classified.tags.includes("check-timeout") ||
      classified.tags.includes("long-lived") ||
      /exceeded wall clock|CHECK_TIMEOUT|long-lived server/i.test(
        classified.summary,
      ))
  ) {
    return "Edit PHASE.md ## Automated Checks: remove long-lived servers and `&`+`wait` hangs. Use finite structural checks (grep/config). Do not background `pnpm dev`/vite.";
  }
  if (
    classified.class === "process" &&
    (classified.tags.includes("host-utility") ||
      /host utility|macos-portability|GNU timeout/i.test(classified.summary))
  ) {
    return "Edit PHASE.md ## Automated Checks: replace GNU `timeout` / missing host utilities with finite structural checks (grep/config asserts). Do NOT background `pnpm dev`/vite with sleep/kill/wait. Do NOT run pnpm/npm install for this fingerprint.";
  }
  if (
    classified.class === "process" &&
    (/exit 127|missing deps|command not found/i.test(classified.summary) ||
      classified.tags.includes("exit-127") ||
      classified.tags.includes("node-modules") ||
      step?.exitCode === 127) &&
    !classified.tags.includes("host-utility")
  ) {
    return "Install dependencies in the **verify cwd** (worktree or project root being checked) with the project package manager (`pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, or `npm ci`). Do not edit PHASE.md Automated Checks for this fingerprint. Do not validate build only on the project root while the worktree lacks node_modules.";
  }
  if (
    classified.class === "process" &&
    /shell|continuation|automated check|PHASE\.md validation/i.test(
      classified.summary,
    ) &&
    !classified.tags.includes("long-lived") &&
    !classified.tags.includes("host-utility") &&
    !classified.tags.includes("check-timeout")
  ) {
    if (/empty test|exit-code capture/i.test(classified.summary)) {
      return 'Edit PHASE.md ## Automated Checks: do not use `echo "VAR=$?"` (prints, does not assign). Prefer `cmd || exit 1` or `VAR=$?` then `test "$VAR" -eq 0`.';
    }
    return "Edit PHASE.md ## Automated Checks: put each check on one complete line (no trailing `\\`). Then address any real product failures.";
  }
  if (
    classified.class === "process" &&
    /embedded ollama|dead-container|placeholder host/i.test(classified.summary)
  ) {
    return "Finish PHASE.md purge: remove jamjar-ollama / ollama-init / http://ollama:11434 / 11435:11434 from compose and tests; keep placeholders only in *.example; put a real host in runtime .env.docker.";
  }
  if (classified.class === "env") {
    return "Operator: ensure project-root .env* / pipeline env match CI/runtime, confirm worktree .env.slopcontrol sync, then retry. Coding agent: do not invent worktree-only fixes.";
  }
  if (classified.class === "model") {
    return "Use llmTestProfile=local (or fixture) + llmModelMap / pipeline OLLAMA_*; do not switch product models to free-tier cloud IDs.";
  }
  if (step?.command) {
    return `Fix the failure of \`${truncate(step.command, 100)}\` (exit ${step.exitCode}) per PHASE.md — do not chase unrelated files.`;
  }
  return classified.learning?.lesson ?? "Inspect the failing step evidence and fix that root cause before expanding scope.";
}

function lastLines(text: string, n: number): string {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  return lines.slice(-n).join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function inferServiceTags(lower: string): string[] {
  const tags: string[] = [];
  if (/postgres|postgresql|pg_|:5432|:5434/.test(lower)) tags.push("postgres");
  if (/redis|:6379/.test(lower)) tags.push("redis");
  if (/mongodb|mongo|:27017/.test(lower)) tags.push("mongodb");
  if (/mysql|:3306/.test(lower)) tags.push("mysql");
  if (/docker|compose/.test(lower)) tags.push("docker");
  if (/elasticsearch|:9200/.test(lower)) tags.push("elasticsearch");
  return tags;
}

function build(
  kind: LearningKind,
  confidence: "high" | "medium" | "low",
  summary: string,
  tags: string[],
  extra: {
    codingAgentShouldFix: boolean;
    lesson: string;
    evidence?: string;
    opts?: { sourcePhaseId?: string; sourceRunId?: string };
    severity?: LearningSeverity;
    operatorActions?: string[];
  },
): ClassifiedFailure {
  const audience: "operator" | "coding" = extra.codingAgentShouldFix
    ? "coding"
    : "operator";
  const operatorActions =
    extra.operatorActions ??
    (audience === "operator" ? defaultOperatorActions(kind, summary) : []);
  return {
    class: kind,
    confidence,
    summary,
    tags,
    codingAgentShouldFix: extra.codingAgentShouldFix,
    audience,
    operatorActions,
    learning: {
      kind,
      tags,
      title: summary,
      lesson: extra.lesson,
      evidence: extra.evidence,
      severity: extra.severity ?? (kind === "infra" ? "blocker" : "warning"),
      sourcePhaseId: extra.opts?.sourcePhaseId,
      sourceRunId: extra.opts?.sourceRunId,
    },
  };
}

function defaultOperatorActions(kind: LearningKind, summary: string): string[] {
  if (kind === "infra" && /llm|ollama|quota|model/i.test(summary)) {
    return [
      "Set a valid LLM key via process.env or project .env.docker / .env.test (pipelines win).",
      "Ensure local Ollama is running if llmTestProfile=local, or set llmTestProfile=fixture.",
      "Set llmSmokeMode=off for develop gates; do not switch product models to free-tier cloud IDs.",
      "Call MCP get_operator_suggestions after fixing env, then retry_development.",
    ];
  }
  if (kind === "infra") {
    return [
      "Restore the runtime dependency named in the diagnosis (compose/service/preflight).",
      "Do not ask the coding agent to invent bring-up scripts in the app repo.",
      "retry_development after services are healthy.",
    ];
  }
  if (kind === "env") {
    return [
      "Ensure required gitignored .env* files exist on the project root (same as CI/runtime).",
      "Confirm SlopControl synced them into the worktree (.env.slopcontrol should list keys).",
      "Prefer setting secrets in process.env / pipeline for CI parity.",
      "Do not engineer product workarounds that only work inside a worktree.",
    ];
  }
  return [
    "Review the diagnosis evidence and take the listed next actions.",
    "Use MCP get_operator_suggestions for the structured action list.",
  ];
}

/** Map FailureClass to LearningKind (unknown → process note). */
export function failureClassToLearningKind(c: FailureClass): LearningKind {
  if (c === "unknown") return "process";
  return c;
}
