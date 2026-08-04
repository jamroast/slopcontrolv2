import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildFailureDiagnosis,
  classifyVerifyFailure,
  coalesceShellCompounds,
  evaluatePlanProgress,
  extractAutomatedChecks,
  extractPlannedFileChanges,
  formatDiagnosisCard,
  isIncompleteShellCompound,
  isMissingNodeBinFailure,
  joinShellContinuations,
  promoteLearning,
  readLearningIndex,
  runVerifyPreflight,
  selectLearningsForContext,
  validatePhaseDocForDev,
} from "./index.js";

describe("classifyVerifyFailure", () => {
  it("classifies connection refused as generic infra (not product-specific)", () => {
    const c = classifyVerifyFailure(
      "Error: connect ECONNREFUSED 127.0.0.1:5434\nnpm test failed",
    );
    assert.equal(c.class, "infra");
    assert.equal(c.codingAgentShouldFix, false);
    assert.ok(c.learning?.lesson.toLowerCase().includes("infrastructure"));
    // May tag postgres as a hint, but classification must not require it
    assert.ok(c.tags.includes("infra"));
  });

  it("classifies Docker port-already-allocated as infra (not coding)", () => {
    const c = classifyVerifyFailure(
      [
        "FAIL: docker compose up -d db",
        "Error response from daemon: failed to set up container networking:",
        "Bind for 0.0.0.0:5433 failed: port is already allocated",
      ].join("\n"),
      { stepName: "post-merge-root-verify:automatedCheck", exitCode: 1 },
    );
    assert.equal(c.class, "infra");
    assert.equal(c.codingAgentShouldFix, false);
    assert.equal(c.audience, "operator");
    assert.match(c.summary, /5433|port/i);
    assert.ok(c.operatorActions.some((a) => /5433|port|compose down/i.test(a)));
  });

  it("classifies isolation port skew (5433 vs 5580) as process, not product hardcode", () => {
    const c = classifyVerifyFailure(
      [
        "FAIL  tests/scripts/env.test.ts > LOCAL_DB_URL",
        "AssertionError: expected 'postgres://app:app@localhost:5580/jamlite' to be 'postgres://app:app@localhost:5433/jamlite'",
        "Expected: \"postgres://app:app@localhost:5433/jamlite\"",
        "Received: \"postgres://app:app@localhost:5580/jamlite\"",
      ].join("\n"),
      { stepName: "post-merge-root-verify:testCommand", command: "npm test", exitCode: 1 },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, false);
    assert.match(c.summary, /isolation/i);
    assert.ok(c.tags.includes("env-isolation"));
  });

  it("classifies redis-style refused the same way", () => {
    const c = classifyVerifyFailure(
      "Redis connection to 127.0.0.1:6379 failed - connect ECONNREFUSED",
    );
    assert.equal(c.class, "infra");
    assert.equal(c.codingAgentShouldFix, false);
  });

  it("classifies model entitlement as infra (use local test profile)", () => {
    const c = classifyVerifyFailure(
      "Ollama Cloud model entitlement 403 — paid subscription required",
    );
    assert.equal(c.class, "infra");
    assert.equal(c.codingAgentShouldFix, false);
    assert.match(c.learning?.lesson ?? "", /llmTestProfile/);
  });

  it("classifies HTTP 429 quota as infra", () => {
    const c = classifyVerifyFailure(
      "Ollama Cloud chat smoke FAILED: HTTP 429 weekly usage limit",
    );
    assert.equal(c.class, "infra");
    assert.equal(c.codingAgentShouldFix, false);
  });

  it("classifies empty-var RC-DEADLOCK as process (cell split)", () => {
    const c = classifyVerifyFailure(
      "FAIL: AI_CHAT_MODEL= == AI_CODE_MODEL= (RC-DEADLOCK)\n",
      {
        stepName: "automatedCheck",
        command: 'if [ "$CHAT_MODEL" = "$CODE_MODEL" ]; then',
      },
    );
    assert.equal(c.class, "process");
    assert.equal(c.confidence, "high");
    assert.equal(c.codingAgentShouldFix, true);
    assert.match(c.learning?.lesson ?? "", /same.*fence|one markdown fence/i);
  });

  it("classifies .env :cloud grep FAIL as process (not LLM quota)", () => {
    const evidence =
      '# Ollama Cloud tier: "paid" (subscription) or "free" (free tier with :cloud models)\n' +
      "FAIL: .env.docker still contains :cloud suffix\n";
    const c = classifyVerifyFailure(evidence, {
      stepName: "automatedCheck",
      command:
        "! grep ':cloud' .env.docker || { echo \"FAIL: .env.docker still contains :cloud suffix\"; exit 1; }",
    });
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
    assert.equal(c.audience, "coding");
    assert.match(c.summary, /env grep|Automated Check/i);
  });

  it("buildFailureDiagnosis routes :cloud comment grep to coding process", () => {
    const d = buildFailureDiagnosis({
      output: "noise",
      firstFailure: {
        name: "automatedCheck",
        command:
          "! grep ':cloud' .env.docker || { echo \"FAIL: .env.docker still contains :cloud suffix\"; exit 1; }",
        exitCode: 1,
        output:
          '# Ollama Cloud tier: "paid" (subscription) or "free" (free tier with :cloud models)\nFAIL: .env.docker still contains :cloud suffix\n',
      },
    });
    assert.equal(d.class, "process");
    assert.equal(d.codingAgentShouldFix, true);
    assert.equal(d.audience, "coding");
  });

  it("classifies embedded ollama / dead-container FAIL as process", () => {
    const c = classifyVerifyFailure(
      "tests/docker.test.ts:330: OLLAMA_BASE_URL=http://ollama:11434/v1\nFAIL: embedded ollama / dead-container reference remains\n",
      { stepName: "automatedCheck", command: "set -euo pipefail" },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
    assert.match(c.summary, /embedded ollama|dead-container/i);
  });

  it("classifies your-box-ip in runtime env dump as process", () => {
    const c = classifyVerifyFailure(
      "OLLAMA_BASE_URL=http://your-box-ip:11434/v1\n.env.docker\n",
    );
    assert.equal(c.class, "process");
    assert.match(c.summary, /placeholder|your-box-ip/i);
  });

  it("redacts API keys in diagnosis evidence", () => {
    const d = buildFailureDiagnosis({
      output: "x",
      firstFailure: {
        name: "automatedCheck",
        command: "set -euo pipefail",
        exitCode: 1,
        output:
          "OLLAMA_API_KEY=should-not-leak.secret\nFAIL: embedded ollama / dead-container reference remains\n",
      },
    });
    assert.doesNotMatch(d.evidence, /should-not-leak/);
    assert.match(d.evidence, /REDACTED/);
    const card = formatDiagnosisCard(d);
    assert.doesNotMatch(card, /should-not-leak/);
  });

  it("classifies missing API key as env with operator audience", () => {
    const c = classifyVerifyFailure(
      "Error: API_KEY missing / not set in environment",
    );
    assert.equal(c.class, "env");
    assert.equal(c.audience, "operator");
    assert.equal(c.codingAgentShouldFix, false);
    assert.ok(c.operatorActions.length > 0);
  });

  it("classifies soft-fail automated checks as process", () => {
    const c = classifyVerifyFailure(
      "Automated check printed FAIL (exit was 0). Prefer `|| exit 1` instead of `|| echo FAIL`.",
    );
    assert.equal(c.class, "process");
  });

  it("classifies assertion failures as product", () => {
    const c = classifyVerifyFailure(
      "AssertionError: expected true to equal false\n  3 failing tests",
    );
    assert.equal(c.class, "product");
    assert.equal(c.codingAgentShouldFix, true);
  });

  it("does not treat dotenv tip noise as env failure", () => {
    const c = classifyVerifyFailure(
      "◇ injected env (9) from .env.local // tip: dotenv\n✖ 12 problems (0 errors, 12 warnings)",
    );
    assert.notEqual(c.class, "env");
  });

  it("classifies shell syntax / trailing continuation as process", () => {
    const trailing = "grep -q 'AI_CHAT_MODEL' src/x.ts && \\";
    const c = classifyVerifyFailure(
      "/bin/sh: -c: line 1: syntax error: unexpected end of file",
      { command: trailing },
    );
    assert.equal(c.class, "process");
    assert.match(c.summary, /shell|continuation|Broken/i);
  });

  it("classifies exit 127 / command not found as process", () => {
    const c = classifyVerifyFailure(
      `
> ai-mind-map@0.1.0 test
> vitest run

sh: vitest: command not found
`,
      { stepName: "testCommand", command: "npm test", exitCode: 127 },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
    assert.match(c.summary, /127|not found|deps/i);
  });

  it("exit 127 nextActions tell agent to install in verify cwd", () => {
    const d = buildFailureDiagnosis({
      output: "sh: tsup: command not found",
      firstFailure: {
        name: "build",
        command: "npm run build",
        exitCode: 127,
        output: "Build failed.\n\n> pkg@0.0.0 build\n> tsup\n\nsh: tsup: command not found\n",
      },
    });
    assert.equal(d.class, "process");
    assert.match(d.nextActions, /verify cwd|pnpm install|npm ci/i);
    assert.match(d.nextActions, /Do not edit PHASE\.md Automated Checks/i);
    assert.doesNotMatch(d.nextActions, /Fix the failure of `npm run build`/);
  });

  it("classifies integer expression expected as broken Automated Check", () => {
    const d = buildFailureDiagnosis({
      output: "post-merge failure",
      firstFailure: {
        name: "post-merge-root-verify:automatedCheck",
        command: "cd /Users/x/proj && pnpm build",
        exitCode: 1,
        output: [
          "POST-MERGE ROOT VERIFY FAILED — worktree build passed; phase branch merged.",
          "> pkg@0.0.0 build",
          "> tsup",
          "BUILD_EXIT=0",
          "/tmp/slop-check/check.sh: line 3: test: : integer expression expected",
        ].join("\n"),
      },
    });
    assert.equal(d.class, "process");
    assert.equal(d.confidence, "high");
    assert.match(d.title, /empty test|exit-code capture/i);
    assert.match(d.nextActions, /echo "VAR=\$\?"|`cmd \|\| exit 1`|PHASE\.md/i);
  });

  it("classifies timeout: command not found as host utility, not deps", () => {
    const d = buildFailureDiagnosis({
      output: "timeout missing",
      firstFailure: {
        name: "post-merge-root-verify:automatedCheck",
        command:
          "cd playground && pnpm install --silent && timeout 8 pnpm dev 2>&1 | tee /tmp/vite-startup.log",
        exitCode: 1,
        output:
          "/var/folders/wn/x/T/slop-check-MUcfWn/check.sh: line 1: timeout: command not found\n",
      },
    });
    assert.equal(d.class, "process");
    assert.equal(d.confidence, "high");
    assert.match(d.title, /host utility|timeout/i);
    assert.ok(d.nextActions);
    assert.match(d.nextActions, /PHASE\.md|portable|timeout/i);
    assert.doesNotMatch(d.nextActions, /pnpm install --frozen|npm ci/i);
    // Must forbid (not recommend) the hang antipattern that replaced GNU timeout
    assert.match(d.nextActions, /Do NOT background/i);
    assert.match(
      d.learning?.lesson ?? "",
      /do NOT start long-lived|finite structural/i,
    );
    assert.doesNotMatch(
      d.nextActions,
      /try background|background pnpm dev \+ sleep/i,
    );
    assert.equal(
      isMissingNodeBinFailure({
        name: d.failingStep?.name,
        command: d.failingStep?.command,
        exitCode: 1,
        output:
          "/var/folders/wn/x/T/slop-check/check.sh: line 1: timeout: command not found\n",
      }),
      false,
    );
  });

  it("classifies CHECK_TIMEOUT as process/high Automated Check hang", () => {
    const d = buildFailureDiagnosis({
      output: "check timed out",
      firstFailure: {
        name: "post-merge-root-verify:automatedCheck",
        command: "pnpm dev & wait",
        exitCode: 124,
        output:
          "VITE v5 ready\n\nCHECK_TIMEOUT after 60000ms\n",
      },
    });
    assert.equal(d.class, "process");
    assert.equal(d.confidence, "high");
    assert.match(d.title, /wall clock|CHECK_TIMEOUT|Automated Check/i);
    assert.match(d.nextActions, /long-lived|PHASE\.md|structural/i);
    assert.doesNotMatch(d.nextActions, /pnpm install --frozen|npm ci/i);
  });

  it("classifies phase-doc-validation long-lived server as long-lived, not trailing-backslash", () => {
    const evidence = `PHASE.md validation failed:
- Broken Automated Check starts a long-lived server (pnpm/npm/yarn/bun dev|start|serve, vite, next dev, docker compose up). Automated Checks must be finite — use structural asserts (grep alias/config) or a short Node one-shot: cd playground && pnpm install --silent 2>&1 && pnpm dev 2>&1 &
VITE_PID=$!
sleep 8
kill $VITE_PID 2>/dev/null
wait $VITE
- Broken Automated Check backgrounds a process (\`&\`) and then \`wait\` — children often outlive kill and hang verify. Do not background servers in Automated Checks: cd playground && pnpm install --silent 2>&1 && pnpm dev 2>&1 &`;
    const d = buildFailureDiagnosis({
      output: evidence,
      firstFailure: {
        name: "phase-doc-validation",
        exitCode: 1,
        output: evidence,
      },
    });
    assert.equal(d.class, "process");
    assert.equal(d.confidence, "high");
    assert.match(d.title, /long-lived server/i);
    assert.ok(d.tags?.includes("long-lived"), String(d.tags));
    assert.match(d.nextActions, /long-lived|structural|Do not background/i);
    assert.doesNotMatch(d.nextActions, /trailing `\\\\`|one complete line/i);
  });

  it("still treats tsup: command not found as node-bin deps", () => {
    const d = buildFailureDiagnosis({
      output: "sh: tsup: command not found",
      firstFailure: {
        name: "build",
        command: "npm run build",
        exitCode: 127,
        output: "sh: tsup: command not found\n",
      },
    });
    assert.equal(d.class, "process");
    assert.match(d.title, /missing deps|exit 127/i);
    assert.match(d.nextActions, /verify cwd|pnpm install|npm ci/i);
    assert.equal(
      isMissingNodeBinFailure({
        name: "build",
        command: "npm run build",
        exitCode: 127,
        output: "sh: tsup: command not found\n",
      }),
      true,
    );
  });

  it("classifies Failed to load url / MODULE_NOT_FOUND as deps process", () => {
    const c = classifyVerifyFailure(
      `FAIL  src/lib/db/__tests__/schema.test.ts
Error: Failed to load url zod (resolved id: zod) in /proj/src/lib/shared/zod-schemas.ts. Does the file exist?`,
      {
        stepName: "post-merge-root-verify:testCommand",
        command: "npm test",
        exitCode: 1,
      },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
    assert.ok(c.tags.includes("deps"));
    assert.match(c.summary, /missing|unresolved|dependenc/i);
  });

  it("classifies .slopcontrol overwrite merge blocks as coding process (not operator)", () => {
    const c = classifyVerifyFailure(
      `Auto-merge failed:
Merge blocked by dirty/untracked paths that would be overwritten merging slop/39 into main.
error: The following untracked working tree files would be overwritten by merge:
	.slopcontrol/phases/39/PHASE.md`,
      { stepName: "auto-merge", exitCode: 1 },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
    assert.equal(c.audience, "coding");
    assert.match(c.summary, /slopcontrol|overwritten|dirty\/untracked/i);
  });

  it("classifies true merge conflicts as operator process", () => {
    const c = classifyVerifyFailure(
      `Auto-merge failed:
Merge conflict merging slop/39 into main; auto-resolve incomplete.
Conflicted paths: package.json.`,
      { stepName: "auto-merge", exitCode: 1 },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, false);
    assert.equal(c.audience, "operator");
  });

  it("classifies unrestored pre-merge stash as operator process (not unknown/coding)", () => {
    const c = classifyVerifyFailure(
      `Auto-merge left unrestored pre-merge stash:
Merged slop/01-phase into main (abc12345). Pre-merge stash kept at stash@{0} (restore with: git stash pop or resolve_conflicts). Merge itself succeeded.
Stash ref: stash@{0}
Restore or drop the pre-merge stash (git stash pop / git stash drop), then continue.`,
      { stepName: "auto-merge", exitCode: 1 },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, false);
    assert.equal(c.audience, "operator");
    assert.ok(c.operatorActions.length > 0);
    assert.match(c.summary, /stash|unrestored/i);
  });
});

describe("buildFailureDiagnosis", () => {
  it("uses firstFailure step not whole-blob noise", () => {
    const d = buildFailureDiagnosis({
      output: "◇ injected env from .env.local\nmany warnings",
      firstFailure: {
        name: "automatedCheck",
        command: "grep -q foo src/a.ts && \\",
        exitCode: 2,
        output: "/bin/sh: -c: line 1: syntax error: unexpected end of file\n",
      },
    });
    assert.equal(d.class, "process");
    assert.equal(d.confidence, "high");
    assert.ok(d.fingerprint.length >= 8);
    assert.match(d.rootCause, /automatedCheck/);
  });
});

describe("shell continuations", () => {
  it("joins backslash-continued Automated Checks into one cell", () => {
    const doc = `# Phase

## Scope
x

## File Changes
- a.ts

## Success Criteria
ok

## Automated Checks

\`\`\`bash
grep -q 'AI_CHAT_MODEL.*glm-5.2' src/lib/chat-agent.ts && \\
grep -q 'AI_CODE_MODEL.*qwen' src/lib/chat-agent.ts || exit 1
npm test || exit 1
\`\`\`
`;
    const cmds = extractAutomatedChecks(doc);
    assert.equal(cmds.length, 1);
    assert.match(cmds[0]!, /AI_CHAT_MODEL[\s\S]*AI_CODE_MODEL/);
    assert.match(cmds[0]!, /npm test/);
  });

  it("joinShellContinuations handles the exact broken-line case", () => {
    const joined = joinShellContinuations([
      "grep -q 'AI_CHAT_MODEL.*glm-5.2' src/lib/chat-agent.ts && \\",
      "grep -q 'AI_CODE_MODEL.*qwen' src/lib/chat-agent.ts || exit 1",
    ]);
    assert.equal(joined.length, 1);
    assert.ok(!joined[0]!.endsWith("\\"));
  });

  it("coalesceShellCompounds joins if/then/fi into one command", () => {
    const joined = coalesceShellCompounds([
      "if grep -qE '^OLLAMA_TIER=paid' .env.docker 2>/dev/null; then",
      "echo ok",
      "fi",
    ]);
    assert.equal(joined.length, 1);
    assert.match(joined[0]!, /\bif\b[\s\S]*\bfi\b/);
    assert.equal(isIncompleteShellCompound(joined[0]!), false);
  });

  it("coalesceShellCompounds keeps incomplete if…then for validation", () => {
    const joined = coalesceShellCompounds([
      "if grep -qE '^OLLAMA_TIER=paid' .env.docker 2>/dev/null; then",
    ]);
    assert.equal(joined.length, 1);
    assert.equal(isIncompleteShellCompound(joined[0]!), true);
  });

  it("extractAutomatedChecks keeps multi-line if/fi fence as one cell", () => {
    const doc = `# Phase

## Scope
x

## File Changes
- a.ts

## Success Criteria
ok

## Automated Checks

\`\`\`bash
npm test || exit 1

if grep -qE '^OLLAMA_TIER=paid' .env.docker 2>/dev/null; then
  echo ok
fi
\`\`\`
`;
    const cmds = extractAutomatedChecks(doc);
    assert.equal(cmds.length, 1);
    assert.match(cmds[0]!, /npm test/);
    assert.match(cmds[0]!, /\bif\b[\s\S]*\bfi\b/);
    assert.equal(validatePhaseDocForDev(doc).ok, true);
  });

  it("validatePhaseDocForDev rejects incomplete if…then Automated Check", () => {
    const doc = `# Phase

## Scope
x

## File Changes
- a.ts

## Success Criteria
ok

## Automated Checks

\`\`\`bash
if grep -qE '^OLLAMA_TIER=paid' .env.docker 2>/dev/null; then
\`\`\`
`;
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, false);
    assert.ok(gate.issues.some((i) => /incomplete shell compound/i.test(i)));
  });

  it("validatePhaseDocForDev rejects trailing continuation leftovers", () => {
    const doc = `# Phase

## Scope
x

## File Changes
- a.ts

## Success Criteria
ok

## Automated Checks

\`\`\`bash
grep -q foo bar && \\
\`\`\`
`;
    const gate = validatePhaseDocForDev(doc);
    const cmds = extractAutomatedChecks(doc);
    if (cmds.some((c) => /\\\s*$/.test(c))) {
      assert.equal(gate.ok, false);
      assert.ok(gate.issues.some((i) => /Broken Automated Check|\\\\/i.test(i)));
    }
  });

  it("validatePhaseDocForDev accepts joined trailing-backslash and quoted JS for-loops", () => {
    const doc = `# Phase 31-model-passthrough: Pass model names verbatim

## Scope

Make resolveModelId a passthrough.

## File Changes

- src/lib/model-resolver.ts

## Success Criteria

- Verbatim model ids

## Automated Checks

\`\`\`bash
# 1. build
npm run build

# 2. multi-line grep with continuations
! grep -rn 'resolveModelId(' src/lib/chat-agent.ts src/lib/model.ts \\
  src/lib/embeddings.ts src/lib/model-catalogue.ts

# 3. tsx one-liner with JS for/if inside quotes
npx tsx -e "
import { resolveModelId } from './src/lib/model-resolver.ts';
const cases = ['glm-5.2:cloud', 'glm-5.2'];
for (const c of cases) {
  const out = resolveModelId(c);
  if (out !== c) { console.error('FAIL'); process.exit(1); }
}
console.log('OK');
"
\`\`\`

## Blueprint Deltas

None.
`;
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, true, gate.issues.join("; "));
  });
});

describe("plan progress", () => {
  const phaseDoc = `# Phase

## File Changes

- src/lib/mcp-config.ts
- \`src/app/api/mcp/route.ts\`
- docs/readme.md — docs only

## Success Criteria

done
`;

  it("extracts planned paths", () => {
    const paths = extractPlannedFileChanges(phaseDoc);
    assert.ok(paths.includes("src/lib/mcp-config.ts"));
    assert.ok(paths.includes("src/app/api/mcp/route.ts"));
    assert.ok(paths.includes("docs/readme.md"));
  });

  it("ignores prose bullets that are not file paths", () => {
    const doc = `# Phase

## File Changes

- scripts/docker.ts
- This gives the orchestrator a semantically distinct action name.
- (full build, picks up env). ✅ already works.

## Success Criteria
done
`;
    const paths = extractPlannedFileChanges(doc);
    assert.deepEqual(paths, ["scripts/docker.ts"]);
  });

  it("detects off-track derail", () => {
    const result = evaluatePlanProgress(phaseDoc, [
      "scripts/ensure-test-db.ts",
      "scripts/skip-tests.ts",
      "tmp/foo.ts",
      "tmp/bar.ts",
      "tmp/baz.ts",
      "package.json",
    ]);
    assert.equal(result.offTrack, true);
    assert.equal(result.ok, false);
  });

  it("accepts covered plan", () => {
    const result = evaluatePlanProgress(phaseDoc, [
      "src/lib/mcp-config.ts",
      "src/app/api/mcp/route.ts",
    ]);
    assert.equal(result.offTrack, false);
    assert.ok(result.covered.length >= 2);
  });
});

describe("learnings store", () => {
  it("promotes, upserts hitCount, and retrieves by context", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-learn-"));
    try {
      const a = promoteLearning(root, {
        kind: "infra",
        tags: ["infra", "runtime-dependency"],
        title: "Runtime dependency unavailable",
        lesson:
          "Bring required local services up before re-running tests; do not invent app bring-up scripts.",
        severity: "blocker",
        sourcePhaseId: "10-mcp",
      });
      assert.ok(a.id);
      const b = promoteLearning(root, {
        kind: "infra",
        tags: ["infra", "runtime-dependency"],
        title: "Runtime dependency unavailable",
        lesson: "Same lesson again.",
        severity: "blocker",
      });
      assert.equal(b.hitCount, 2);
      assert.equal(readLearningIndex(root).learnings.length, 1);
      assert.ok(existsSync(join(root, ".slopcontrol", "LEARNINGS.md")));
      const md = readFileSync(
        join(root, ".slopcontrol", "LEARNINGS.md"),
        "utf-8",
      );
      assert.match(md, /Runtime dependency unavailable/);

      const selected = selectLearningsForContext(root, {
        failureText: "ECONNREFUSED runtime dependency",
      });
      assert.ok(selected.some((L) => L.id === a.id));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runVerifyPreflight", () => {
  it("skips when command unset", async () => {
    const r = await runVerifyPreflight("/tmp", undefined, async () => ({
      output: "",
      exitCode: 0,
    }));
    assert.equal(r.skipped, true);
    assert.equal(r.ok, true);
  });

  it("fails with generic infra messaging", async () => {
    const r = await runVerifyPreflight(
      "/tmp",
      "echo healthcheck",
      async () => ({ output: "not ready\n", exitCode: 1 }),
    );
    assert.equal(r.ok, false);
    assert.match(r.output, /infrastructure/i);
    assert.match(r.output, /verifyPreflightCommand FAILED/);
  });
});
