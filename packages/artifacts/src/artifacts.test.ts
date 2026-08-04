import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allocatePhaseId,
  applyProposedRoadmap,
  archiveBlueprint,
  bootstrapFromResearch,
  buildProjectInventory,
  ensureSlopcontrolDir,
  extractMarkdownDocument,
  mergePhaseIntoBlueprint,
  readBlueprint,
  readPhaseDoc,
  readResearch,
  readRoadmap,
  resetProjectToPhaseZero,
  synthesizeBlueprintFromInventory,
  extractAutomatedChecks,
  validateBlueprintDocument,
  validatePhaseDocForDev,
  verifyDatabaseArtifacts,
  verifyOllamaCloudModelIds,
  detectCodingProbeAbuse,
  writeBlueprint,
  writePhaseDoc,
  writePhaseStatus,
  writeResearch,
  writeRoadmap,
  isProjectEmpty,
  isThinResearch,
  extractChangeIntent,
  phaseDocWatchPaths,
  resolvePhaseDocFromAgentTurn,
  scaffoldPhaseDoc,
  snapshotFileStats,
  isSoftFailEchoCheck,
  automatedCheckReportedFailure,
  isPhaseDocPreamble,
  writeCheckReport,
  writeDiagnosis,
  phaseNeedsDesign,
  isDesignComplete,
  markDesignComplete,
  writeUiSpec,
  writeChangeIntent,
  parseDesignAssetBriefs,
  isDatabasePhase,
} from "./index.js";

describe("@slopcontrol/artifacts", () => {
  it("creates ordered phase ids", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-ord-"));
    try {
      ensureSlopcontrolDir(projectRoot);
      const first = allocatePhaseId(projectRoot, "Fix Docker DB tables");
      assert.equal(first.id, "01-fix-docker-db-tables");
      writePhaseDoc(projectRoot, first.id, "# Phase\n\nPlan.");
      const second = allocatePhaseId(projectRoot, "Add auth");
      assert.equal(second.id, "02-add-auth");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("strips agent preamble when writing research/phase", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-md-"));
    try {
      writeResearch(
        projectRoot,
        "01-test",
        "Let me think...\n\n# RESEARCH.md\n\nFindings.\n\nRESEARCH_COMPLETE\n",
      );
      assert.equal(readResearch(projectRoot, "01-test").trim(), "# RESEARCH.md\n\nFindings.");
      assert.equal(
        extractMarkdownDocument("chat\n\n```markdown\n# Doc\n\nBody\n```\n"),
        "# Doc\n\nBody",
      );
      // Bare code fences must not replace a structured blueprint
      const withFence = [
        "# Blueprint",
        "",
        "## Architecture",
        "",
        "```",
        "diagram only",
        "```",
        "",
        "## Tech stack",
        "",
        "Uses Next.js and plenty of supporting detail here.",
      ].join("\n");
      const extracted = extractMarkdownDocument(withFence);
      assert.match(extracted, /^# Blueprint/);
      assert.match(extracted, /## Tech stack/);
      assert.match(extracted, /diagram only/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("extractMarkdownDocument prefers # Phase over in-fence # comments", () => {
    const raw = `Now rewriting the plan.Let me rewrite it.# Phase 31-miss-mapping: Pass model names verbatim

## Scope

Make resolveModelId a passthrough.

## File Changes

- src/lib/model-resolver.ts

## Success Criteria

- Verbatim model ids

## Automated Checks

\`\`\`bash
npm test
\`\`\`

### Example env comment

\`\`\`
# OLLAMA_TIER is informational only and does not rewrite model IDs.
OLLAMA_TIER=paid
\`\`\`

## Blueprint Deltas

None.
`;
    const doc = extractMarkdownDocument(raw);
    assert.match(doc, /^# Phase 31-miss-mapping/);
    assert.match(doc, /## Scope/);
    assert.equal(doc.startsWith("# OLLAMA_TIER"), false);
    assert.match(doc, /## Blueprint Deltas/);
  });

  it("extractMarkdownDocument does not latch onto in-fence # when Phase title missing at line start", () => {
    // Mid-line title only — promoteMidLineDocTitle must still recover # Phase
    const raw = `chat preamble rewrite it.# Phase 09-fix: Save workflows

## Scope

Fix save.

## File Changes

- a.ts

## Success Criteria

ok

## Automated Checks

\`\`\`bash
# this is a shell comment not the doc title
npm test
\`\`\`
`;
    const doc = extractMarkdownDocument(raw);
    assert.match(doc, /^# Phase 09-fix/);
  });

  it("archives blueprint and bootstraps from research", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-bp-"));
    try {
      writeBlueprint(projectRoot, "# Blueprint\n\nOld.");
      const archived = archiveBlueprint(projectRoot);
      assert.ok(archived && existsSync(archived));
      assert.equal(readBlueprint(projectRoot), "");

      const result = bootstrapFromResearch(
        projectRoot,
        `# Research\n\n## Proposed Blueprint\n\n# Blueprint\n\nNew design.\n\n## Proposed Roadmap\n\n| Phase | Title | Status |\n| 01-db | DB | planned |\n`,
      );
      assert.equal(result.blueprintWritten, true);
      assert.match(readBlueprint(projectRoot), /New design/);
      assert.match(readRoadmap(projectRoot), /01-db/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("merges blueprint deltas into decisions", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-merge-"));
    try {
      writeBlueprint(projectRoot, "# Blueprint\n\nBase.");
      mergePhaseIntoBlueprint(
        projectRoot,
        "01-auth",
        `# Phase\n\n## Blueprint Deltas\n\nUse Postgres for auth sessions.\n\n## Build Order\n\n1. models\n`,
        "Add auth",
      );
      const blueprint = readBlueprint(projectRoot);
      assert.match(blueprint, /Use Postgres for auth sessions/);
      assert.doesNotMatch(blueprint, /## Build Order/);
      assert.match(blueprint, /Decisions — 01-auth/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("verifies database DDL artifacts", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-db-"));
    try {
      mkdirSync(join(projectRoot, "docker"), { recursive: true });
      writeFileSync(
        join(projectRoot, "docker", "init-db.sql"),
        "CREATE TABLE users (id uuid);\n",
      );
      const result = verifyDatabaseArtifacts(projectRoot);
      assert.equal(result.ok, true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("extracts Automated Checks from PHASE.md bash fences", () => {
    const doc = `# Phase

## Scope

Do the thing

## File Changes

- a.ts

## Success Criteria

Manual: click the button

## Automated Checks

\`\`\`bash
npm run typecheck
# comment
npm test -- tests/docker.test.ts
\`\`\`

## Blueprint Deltas

None.
`;
    assert.deepEqual(extractAutomatedChecks(doc), [
      "npm run typecheck\n# comment\nnpm test -- tests/docker.test.ts",
    ]);
    assert.equal(validatePhaseDocForDev(doc).ok, true);
  });

  it("rejects PHASE.md without Automated Checks", () => {
    const doc = `# Phase\n\n## Success Criteria\n\nManual only.\n`;
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, false);
    assert.ok(gate.issues.some((i) => /Automated Checks/i.test(i)));
    assert.deepEqual(extractAutomatedChecks(doc), []);
  });

  it("rejects secret-bearing Automated Checks and planner preamble", () => {
    const preamble = `Let me draft this.

# Phase

## Scope

x

## File Changes

y

## Success Criteria

z

## Automated Checks

\`\`\`bash
curl -H "Authorization: Bearer $OLLAMA_API_KEY" https://api.ollama.cloud/v1/models
\`\`\`
`;
    const gate = validatePhaseDocForDev(preamble);
    assert.equal(gate.ok, false);
    assert.ok(gate.issues.some((i) => /preamble|Forbidden secret/i.test(i)));
  });

  it("does not treat Here's quotes inside Scope as planner preamble", () => {
    const doc = `# Phase 51-single-field: Switch to validated single-field form

## Scope

When the assistant asks for a CSV URL, show a form. Transcript quote:

Here's what it needs:
| Parameter | Required |
| fileUrl | yes |

Do not treat that quote as chat preamble.

## File Changes

- src/components/chat/form-bubble.tsx

## Success Criteria

- Single-field form appears for one missing param

## Automated Checks

\`\`\`bash
npm test
\`\`\`
`;
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, true, gate.issues.join("; "));
    assert.equal(isPhaseDocPreamble(doc), false);
  });

  it("clips long chat-dump descriptions in scaffold Scope", () => {
    const chatDump = [
      '## Want me to promote this?',
      "",
      "I'd love to help you build a workflow!",
      "Here's what it needs:",
      "x".repeat(800),
    ].join("\n");
    const doc = scaffoldPhaseDoc({
      phaseId: "51-flow",
      description: chatDump,
      testCommand: "npm test",
    });
    assert.equal(validatePhaseDocForDev(doc).ok, true, validatePhaseDocForDev(doc).issues.join("; "));
    assert.match(doc, /clipped for scaffold/);
    assert.ok(doc.length < chatDump.length + 800);
  });

  it("rejects Automated Checks that force OLLAMA_TIER=free", () => {
    const doc = `# Phase

## Scope
x

## File Changes
- .env.docker

## Success Criteria
ok

## Automated Checks

\`\`\`bash
grep -E '^OLLAMA_TIER=free' .env.docker >/dev/null || exit 1
\`\`\`
`;
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, false);
    assert.ok(gate.issues.some((i) => /free-tier force/i.test(i)));
  });

  it("rejects PHASE.md that mandates paid→free env switch", () => {
    const doc = `# Phase

## Scope
Update \`.env.docker\` to OLLAMA_TIER=free since the evidence shows the key is free-tier.

## File Changes
- .env.docker

## Success Criteria
- change \`OLLAMA_TIER=paid\` → \`OLLAMA_TIER=free\`

## Automated Checks

\`\`\`bash
npm test
\`\`\`
`;
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, false);
    assert.ok(gate.issues.some((i) => /OLLAMA_TIER=free|free-tier/i.test(i)));
  });

  it("harvests tool-written PHASE.md when agent only narrates", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-harvest-"));
    try {
      const phaseId = "09-i-am-having-problems-saving-the-workflow";
      const watch = phaseDocWatchPaths(projectRoot, phaseId);
      const before = snapshotFileStats(watch);

      const good = `# Phase 09: Fix Workflow Save Failures

## Scope

Users cannot save workflows through chat.

## File Changes

- src/lib/chat-agent.ts

## Success Criteria

- Save works end-to-end

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      writeFileSync(join(projectRoot, "PHASE.md"), good, "utf-8");

      const resolved = resolvePhaseDocFromAgentTurn({
        projectRoot,
        phaseId,
        agentOutput:
          "PHASE.md has been rewritten. Here's what changed from the previous version...",
        beforeStats: before,
        description:
          "I am having problems saving the workflow please can you investigate",
      });
      assert.equal(resolved.gate.ok, true, resolved.gate.issues.join("; "));
      assert.equal(resolved.source, "tool_write");
      assert.match(resolved.doc, /Fix Workflow Save Failures/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects wrong-phase root PHASE.md even when changed this turn", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-harvest-wrong-"));
    try {
      const phaseId = "31-there-is-a-miss-mapping-in-the-env-docke";
      const watch = phaseDocWatchPaths(projectRoot, phaseId);
      const before = snapshotFileStats(watch);

      const stale = `# Phase 30-ollama-host-docker-internal-routing

## Scope

Repoint Ollama hosts to host.docker.internal.

## File Changes

- docker-compose.yml

## Success Criteria

- Containers reach Ollama via host.docker.internal

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      writeFileSync(join(projectRoot, "PHASE.md"), stale, "utf-8");

      const resolved = resolvePhaseDocFromAgentTurn({
        projectRoot,
        phaseId,
        agentOutput: "Drafted PHASE.md at the project root.",
        beforeStats: before,
        description:
          "There is a miss mapping in the env docker model names for Ollama cloud",
      });
      assert.equal(resolved.source, "none");
      assert.equal(resolved.doc, "");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("prefers canonical phase PHASE.md over wrong-phase root leftover", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-harvest-canon-"));
    try {
      const phaseId = "31-there-is-a-miss-mapping-in-the-env-docke";
      const watch = phaseDocWatchPaths(projectRoot, phaseId);
      const before = snapshotFileStats(watch);

      const stale = `# Phase 30-host-docker-internal

## Scope

host.docker.internal routing.

## File Changes

- compose.yml

## Success Criteria

- Hosts resolve

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      const good = `# Phase 31-there-is-a-miss-mapping-in-the-env-docke

## Scope

Pass env model names verbatim; stop tier-based :cloud strip/add.

## File Changes

- src/lib/model-resolver.ts

## Success Criteria

- glm-5.2:cloud used as configured

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      writeFileSync(join(projectRoot, "PHASE.md"), stale, "utf-8");
      mkdirSync(join(projectRoot, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeFileSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        good,
        "utf-8",
      );

      const resolved = resolvePhaseDocFromAgentTurn({
        projectRoot,
        phaseId,
        agentOutput: "Wrote PHASE.md",
        beforeStats: before,
        description:
          "There is a miss mapping in the env docker model names",
      });
      assert.equal(resolved.gate.ok, true, resolved.gate.issues.join("; "));
      assert.equal(resolved.source, "tool_write");
      assert.match(resolved.doc, /Pass env model names verbatim/);
      assert.match(resolved.path ?? "", /\.slopcontrol[/\\]phases[/\\]31-/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects retitled prior-phase PHASE that ignores RESEARCH focus", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-harvest-align-"));
    try {
      const phaseId = "31-there-is-a-miss-mapping-in-the-env-docke";
      const research = `# RESEARCH — Phase 31: Remove automatic :cloud suffix stripping; pass env model names verbatim

## Summary

Fix src/lib/model-resolver.ts resolveModelId so it does not strip or add :cloud
based on OLLAMA_TIER. Use AI_CHAT_MODEL verbatim.
`;
      const retitled = `# Phase 31-there-is-a-miss-mapping-in-the-env-docke: Replace box-LAN-IP with host.docker.internal

## Scope

Add extra_hosts host.docker.internal:host-gateway and replace 192.168.3.107
routing. Config/infra only.

## File Changes

- docker-compose.yml
- .env.docker.example

## Success Criteria

- host.docker.internal works

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      const watch = phaseDocWatchPaths(projectRoot, phaseId);
      const before = snapshotFileStats(watch);
      mkdirSync(join(projectRoot, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeFileSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        retitled,
        "utf-8",
      );

      const resolved = resolvePhaseDocFromAgentTurn({
        projectRoot,
        phaseId,
        agentOutput: "PHASE.md written",
        beforeStats: before,
        description:
          "There is a miss mapping in the env docker model names for Ollama",
        research,
      });
      assert.equal(resolved.source, "none");
      assert.ok(
        (resolved.alignIssues?.length ?? 0) > 0,
        "expected research alignment issues",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("accepts PHASE that plans model-resolver work matching RESEARCH", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-harvest-align-ok-"));
    try {
      const phaseId = "31-there-is-a-miss-mapping-in-the-env-docke";
      const research = `# RESEARCH — Phase 31: Remove automatic :cloud suffix stripping; pass env model names verbatim

## Summary

Fix src/lib/model-resolver.ts resolveModelId so it does not strip or add :cloud
based on OLLAMA_TIER. Use AI_CHAT_MODEL verbatim.
`;
      const good = `# Phase 31-there-is-a-miss-mapping-in-the-env-docke: Pass model names verbatim

## Scope

Stop tier-based :cloud strip/add in resolveModelId; pass env model names verbatim.

## File Changes

- src/lib/model-resolver.ts
- related unit tests

## Success Criteria

- glm-5.2:cloud used as configured when OLLAMA_TIER=paid

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      const watch = phaseDocWatchPaths(projectRoot, phaseId);
      const before = snapshotFileStats(watch);
      mkdirSync(join(projectRoot, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeFileSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        good,
        "utf-8",
      );

      const resolved = resolvePhaseDocFromAgentTurn({
        projectRoot,
        phaseId,
        agentOutput: "done",
        beforeStats: before,
        description: "miss mapping in the env docker model names",
        research,
      });
      assert.equal(resolved.source, "tool_write");
      assert.equal(resolved.gate.ok, true);
      assert.match(resolved.doc, /model-resolver/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("detects soft-fail echo checks and printed FAIL markers", () => {
    assert.equal(
      isSoftFailEchoCheck(
        'grep -q x file || echo "FAIL: missing"',
      ),
      true,
    );
    assert.equal(isSoftFailEchoCheck("grep -q x file || exit 1"), false);
    assert.equal(
      automatedCheckReportedFailure("PASS: ok\n"),
      false,
    );
    assert.equal(
      automatedCheckReportedFailure("FAIL: Phase 08 columns missing from migration\n"),
      true,
    );
  });

  it("writeCheckReport persists under runs/<id>/checks", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-checks-"));
    try {
      const path = writeCheckReport(
        projectRoot,
        "run-1",
        "iter3-root-verify",
        "full check output here\n",
      );
      assert.ok(existsSync(path));
      assert.match(path, /checks/);
      assert.equal(
        readFileSync(
          join(projectRoot, ".slopcontrol", "runs", "run-1", "checks", "latest-iter3-root-verify.txt"),
          "utf-8",
        ),
        "full check output here\n",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("writeCheckReport redacts API keys", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-checks-redact-"));
    try {
      writeCheckReport(
        projectRoot,
        "run-2",
        "root-verify",
        "OLLAMA_API_KEY=should-not-leak.secret\nFAIL: x\n",
      );
      const body = readFileSync(
        join(
          projectRoot,
          ".slopcontrol",
          "runs",
          "run-2",
          "checks",
          "latest-root-verify.txt",
        ),
        "utf-8",
      );
      assert.doesNotMatch(body, /should-not-leak/);
      assert.match(body, /REDACTED/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("writePhaseStatus complete clears failure diagnosis", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-diag-clear-"));
    try {
      writeDiagnosis(
        projectRoot,
        "run-x",
        {
          audience: "coding",
          operatorActions: [],
          class: "unknown",
          confidence: "low",
          title: "Unclassified verify failure",
          rootCause: "fail",
          evidence: "x",
          nextActions: "fix",
          fingerprint: "abc",
          codingAgentShouldFix: true,
          updatedAt: new Date().toISOString(),
        },
        "01-test",
      );
      writePhaseStatus(projectRoot, "01-test", "complete");
      const diag = JSON.parse(
        readFileSync(
          join(projectRoot, ".slopcontrol", "phases", "01-test", "diagnosis.json"),
          "utf-8",
        ),
      ) as { title: string; fingerprint: string };
      assert.equal(diag.fingerprint, "complete");
      assert.match(diag.title, /complete/i);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("scaffolds a valid PHASE.md when planning fails", () => {
    const doc = scaffoldPhaseDoc({
      phaseId: "09-save",
      description: "fix workflow save",
      testCommand: "npm test",
    });
    assert.equal(validatePhaseDocForDev(doc).ok, true);
    assert.equal(isThinResearch("I'll look around."), true);
    assert.equal(
      isThinResearch(
        "Now let me check if there are any tests or scripts that could help verify model availability:",
      ),
      true,
    );
    assert.equal(
      isThinResearch("# Research\n\n" + "x".repeat(500) + "\n\n## Notes\n\nok"),
      false,
    );
  });

  it("engagement scaffold includes live tool-part proof language", () => {
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer.",
    );
    const doc = scaffoldPhaseDoc({
      phaseId: "56-forms",
      description: "fix forms",
      testCommand: "npm test",
      intent,
    });
    assert.match(doc, /parseToolResult|tool-/i);
    assert.match(doc, /composer|fill|submit/i);
  });

  it("verifyOllamaCloudModelIds flags bare model names", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-ollama-"));
    try {
      writeFileSync(
        join(projectRoot, ".env.docker"),
        [
          "OLLAMA_BASE_URL=https://api.ollama.cloud/v1",
          "AI_CHAT_MODEL=glm-5.2",
          "AI_CODE_MODEL=glm-5.2:cloud",
          "",
        ].join("\n"),
      );
      const result = verifyOllamaCloudModelIds(projectRoot);
      assert.equal(result.ok, false);
      assert.match(result.output, /AI_CHAT_MODEL=glm-5\.2/);
      assert.ok(
        result.remediation.some((r) =>
          /llmTestProfile|local|do NOT switch/i.test(r),
        ),
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("verifyOllamaCloudChatAccess skips when smoke disabled", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-smoke-skip-"));
    const prev = process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE;
    process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE = "1";
    try {
      writeFileSync(
        join(projectRoot, ".env.docker"),
        "OLLAMA_BASE_URL=https://api.ollama.cloud/v1\nAI_CHAT_MODEL=glm-5.2:cloud\nOLLAMA_API_KEY=test\n",
      );
      const { verifyOllamaCloudChatAccess } = await import("./index.js");
      const result = await verifyOllamaCloudChatAccess(projectRoot);
      assert.equal(result.ok, true);
      assert.match(result.output, /skipped/i);
    } finally {
      if (prev === undefined) delete process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE;
      else process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE = prev;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("detectCodingProbeAbuse catches bearer curls", () => {
    const hit = detectCodingProbeAbuse(
      'curl -H "Authorization: Bearer secret" https://api.ollama.cloud/v1/chat',
    );
    assert.ok(hit);
    assert.equal(detectCodingProbeAbuse("npm test"), null);
    assert.equal(
      detectCodingProbeAbuse(
        "URL: https://api.ollama.cloud/v1/chat/completions\ndo not curl live APIs",
      ),
      null,
    );
  });

  it("resets project artifacts to phase zero", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-reinit-"));
    try {
      writeBlueprint(projectRoot, "# Blueprint\n\nOld.");
      writePhaseDoc(projectRoot, "01-old", "# Phase\n\nDone.");
      const result = resetProjectToPhaseZero(projectRoot);
      assert.ok(existsSync(result.archiveRoot));
      assert.equal(result.archivedBlueprint, true);
      assert.equal(result.archivedPhaseDirs, 1);
      assert.equal(readBlueprint(projectRoot), "");
      assert.match(readRoadmap(projectRoot), /Depends on/);
      const next = allocatePhaseId(projectRoot, "Fresh start");
      assert.equal(next.id, "01-fresh-start");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("detects empty vs non-empty project trees", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "slop-empty-"));
    const filledRoot = mkdtempSync(join(tmpdir(), "slop-filled-"));
    try {
      mkdirSync(join(emptyRoot, ".git"), { recursive: true });
      writeFileSync(join(emptyRoot, "README.md"), "# hi\n");
      assert.equal(isProjectEmpty(emptyRoot), true);

      mkdirSync(join(filledRoot, "src"), { recursive: true });
      writeFileSync(join(filledRoot, "src", "index.ts"), "console.log(1);\n");
      assert.equal(isProjectEmpty(filledRoot), false);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
      rmSync(filledRoot, { recursive: true, force: true });
    }
  });

  it("builds a project inventory including docker and package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-inv-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "demo",
          scripts: { dev: "next" },
          dependencies: { next: "15" },
        }),
      );
      writeFileSync(join(root, "Dockerfile"), "FROM node:20\n");
      writeFileSync(join(root, "docker-compose.yml"), "services:\n  db:\n");
      mkdirSync(join(root, "docker"), { recursive: true });
      writeFileSync(join(root, "docker", "init-db.sql"), "CREATE TABLE t(id int);\n");
      mkdirSync(join(root, "src", "app", "api", "chat"), { recursive: true });
      writeFileSync(join(root, "src", "app", "api", "chat", "route.ts"), "export {}");
      const inv = buildProjectInventory(root);
      assert.ok(inv.mustReadPresent.includes("package.json"));
      assert.ok(inv.dockerFiles.some((f) => /Dockerfile/i.test(f)));
      assert.ok(inv.sqlFiles.some((f) => f.endsWith("init-db.sql")));
      assert.ok(inv.apiRoutes.some((f) => f.includes("api/chat")));
      assert.match(inv.markdown, /Must-read files present/);
      assert.match(inv.packageSummary ?? "", /next/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("synthesizes a contract-valid blueprint from inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-synth-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "demo",
          scripts: { test: "vitest" },
          dependencies: { next: "15", "drizzle-orm": "0.45" },
        }),
      );
      writeFileSync(join(root, "Dockerfile"), "FROM node:20\n");
      writeFileSync(join(root, "docker-compose.yml"), "services:\n  db:\n");
      mkdirSync(join(root, "docker"), { recursive: true });
      writeFileSync(join(root, "docker", "init.sql"), "CREATE TABLE t(id int);\n");
      mkdirSync(join(root, "src", "app", "api", "chat"), { recursive: true });
      writeFileSync(join(root, "src", "app", "api", "chat", "route.ts"), "export {}");
      const inv = buildProjectInventory(root);
      const doc = synthesizeBlueprintFromInventory({
        inventory: inv,
        operatorNotes: "Maker-like skills platform",
        llmDraft: "User → Chat → LLM (diagram only)",
      });
      const result = validateBlueprintDocument(doc);
      assert.equal(result.ok, true, result.issues.join("; "));
      assert.match(doc, /Dockerfile|docker-compose/);
      assert.match(doc, /01-blueprint-deepen/);
      assert.match(doc, /Maker-like/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates blueprint contract and applies proposed roadmap over stubs", () => {
    const thin = "User → Chat → LLM\n";
    const thinResult = validateBlueprintDocument(thin);
    assert.equal(thinResult.ok, false);

    const sections = [
      "Product summary",
      "Architecture",
      "Tech stack",
      "Modules and key paths",
      "Data model",
      "Infra and deploy",
      "Skills / tools / workflows",
      "Auth and tenancy",
      "Tests and quality gates",
      "Known gaps / risks / unused scaffolding",
      "Proposed Roadmap",
    ];
    const full = [
      "# Blueprint",
      ...sections.flatMap((s) => [
        `## ${s}`,
        s === "Proposed Roadmap"
          ? "| Phase | Title | Status | Depends on |\n| 01-scaffold | Bootstrap | planned | |"
          : `Substantial content for ${s} covering the real system in enough detail.`,
      ]),
    ].join("\n\n");
    const ok = validateBlueprintDocument(full);
    assert.equal(ok.ok, true, ok.issues.join("; "));

    const root = mkdtempSync(join(tmpdir(), "slop-roadmap-"));
    try {
      writeRoadmap(
        root,
        "# Roadmap\n\n| Phase | Title | Status | Depends on |\n|-------|-------|--------|------------|\n",
      );
      assert.equal(applyProposedRoadmap(root, full), true);
      assert.match(readRoadmap(root), /01-scaffold/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("phaseNeedsDesign detects Brand/Assets/UI-SPEC and DESIGN_COMPLETE", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-design-"));
    try {
      ensureSlopcontrolDir(root);
      const phaseId = "01-brand";
      assert.equal(phaseNeedsDesign(root, phaseId), false);

      writePhaseDoc(
        root,
        phaseId,
        `# Phase 01-brand

## Scope
Brand pass

## File Changes
- public/brand/logo.svg

## Success Criteria
Logo ships

## Automated Checks
\`\`\`bash
test -f public/brand/logo.svg
\`\`\`
`,
      );
      assert.equal(phaseNeedsDesign(root, phaseId), false);

      writePhaseDoc(
        root,
        phaseId,
        `# Phase 01-brand

## Scope
Brand

## Brand
Acme

## Assets
| Name | Filename | Prompt |
| logo | logo.png | mark |

## File Changes
- x

## Success Criteria
ok

## Automated Checks
\`\`\`bash
true
\`\`\`
`,
      );
      assert.equal(phaseNeedsDesign(root, phaseId), true);
      assert.equal(isDesignComplete(root, phaseId), false);

      writeUiSpec(root, phaseId, "# UI-SPEC\n\n## Palette\n#111\n");
      assert.equal(phaseNeedsDesign(root, phaseId), true);

      markDesignComplete(root, phaseId);
      assert.equal(isDesignComplete(root, phaseId), true);

      const briefs = parseDesignAssetBriefs(`## Assets
| Name | Filename | Prompt |
| --- | --- | --- |
| logo | logo.png | circular mark |
| hero | hero.png | wide banner |
`);
      assert.equal(briefs.length, 2);
      assert.equal(briefs[0]?.filename, "logo.png");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("phaseNeedsDesign routes by changeKind (chrome-hide/backend skip unless forced)", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-design-kind-"));
    try {
      ensureSlopcontrolDir(root);
      const phaseId = "57-chrome";
      const plainPhase = `# Phase ${phaseId}

Requires design pass: no

## Scope
Hide empty form chrome

## File Changes
- src/lib/active-form.ts

## Success Criteria
Empty form shows chat only

## Automated Checks
\`\`\`bash
npx vitest run tests/active-form.test.ts
\`\`\`
`;
      writePhaseDoc(root, phaseId, plainPhase);
      writeChangeIntent(root, phaseId, {
        title: "Hide empty form tabs",
        goal: "Hide tab strip when nothing to gather",
        uiMount: "composer",
        changeKind: "chrome-hide",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: "Hide blank form tabs",
      });
      assert.equal(phaseNeedsDesign(root, phaseId), false);

      // Leftover UI-SPEC alone must not force design for chrome-hide
      writeUiSpec(root, phaseId, "# UI-SPEC\n\n## Palette\n#111\n");
      assert.equal(phaseNeedsDesign(root, phaseId), false);

      writePhaseDoc(
        root,
        phaseId,
        `# Phase ${phaseId}

Requires design pass: yes

## Scope
Forced visual

## File Changes
- x

## Success Criteria
ok

## Automated Checks
\`\`\`bash
true
\`\`\`
`,
      );
      assert.equal(phaseNeedsDesign(root, phaseId), true);

      const backendId = "12-backend";
      writePhaseDoc(
        root,
        backendId,
        `# Phase ${backendId}

## Scope
DB pool

## File Changes
- src/db.ts

## Success Criteria
ok

## Automated Checks
\`\`\`bash
true
\`\`\`
`,
      );
      writeChangeIntent(root, backendId, {
        title: "Fix DB pool",
        goal: "Tune connection pool",
        uiMount: "n/a",
        changeKind: "backend",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: "Fix database pool",
      });
      assert.equal(phaseNeedsDesign(root, backendId), false);

      const engId = "56-engagement";
      writePhaseDoc(
        root,
        engId,
        `# Phase ${engId}

## Scope
Forms

## Assets
| Name | Filename | Prompt |
| logo | logo.png | mark |

## File Changes
- x

## Success Criteria
ok

## Automated Checks
\`\`\`bash
true
\`\`\`
`,
      );
      writeChangeIntent(root, engId, {
        title: "Populate and submit forms",
        goal: "Fill and submit in composer",
        uiMount: "composer",
        changeKind: "engagement",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: "Populate and submit",
        interaction: {
          mount: "composer",
          primaryAction: "submit form",
          proof: ["composer-form"],
          forbiddenSubstitutes: ["chips"],
        },
      });
      assert.equal(phaseNeedsDesign(root, engId), true);

      // Brand theming even if mislabeled backend still needs design
      const brandId = "12-brand";
      writePhaseDoc(
        root,
        brandId,
        `# Phase ${brandId}

## Scope
Apply theming

## File Changes
- globals.css

## Success Criteria
ok

## Automated Checks
\`\`\`bash
true
\`\`\`
`,
      );
      writeChangeIntent(root, brandId, {
        title: "for me to promote to research.",
        goal: "apply the theming from basic-web-agent and a new logo",
        uiMount: "n/a",
        changeKind: "backend",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription:
          "Please apply the theming from JamPress and a cleaner logo",
      });
      assert.equal(phaseNeedsDesign(root, brandId), true);

      // Theme toggle / data-theme wiring is not a brand identity design pass
      const themeId = "09-theme-toggle";
      writePhaseDoc(
        root,
        themeId,
        `# Phase ${themeId}

## Scope
Audit ThemeToggle and data-theme wiring on the landing page.

## Brand
Not applicable — this phase does not introduce new brand assets, logos, or wordmarks.

## Assets
Not applicable — no new static assets, favicons, or design files.

## File Changes
- src/hooks/useTheme.ts

## Success Criteria
ThemeToggle switches data-theme

## Automated Checks
\`\`\`bash
pnpm test
\`\`\`
`,
      );
      writeChangeIntent(root, themeId, {
        title: "Audit and fix light/dark theme toggle on landing page",
        goal: "Verify ThemeToggle drives landing components via data-theme.",
        uiMount: "page",
        changeKind: "other",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription:
          "Audit the existing light/dark theme toggle implementation and verify it drives the landing page.",
      });
      assert.equal(phaseNeedsDesign(root, themeId), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("brand theming Intent classifies as other not backend", () => {
    const intent = extractChangeIntent(
      "Please apply the theming from /Users/brettchaldecott/Projects/basic-web-agent and a new logo based on jampress concepts",
    );
    assert.equal(intent.changeKind, "other");
    assert.equal(intent.interaction, undefined);
  });

  it("parseDesignAssetBriefs uses ## Assets only (ignores Palette tables)", () => {
    const uiSpec = `# UI-SPEC

## Palette
| Role | Hex | Notes |
| --- | --- | --- |
| Brand primary | #1a2b3c | Main brand |
| Accent | #ff6600 | CTA |

## Typography
| Role | Stack |
| --- | --- |
| Display | Fraunces |

## Assets
| Name | Filename | Prompt |
| --- | --- | --- |
| mark | logo.svg | circular jam press mark |
| og | og-image.png | wide social card with brand mark |

## Logo brief
Unused when Assets table present.
`;
    const briefs = parseDesignAssetBriefs(uiSpec);
    assert.equal(briefs.length, 2);
    assert.equal(briefs[0]?.filename, "logo.svg");
    assert.equal(briefs[1]?.filename, "og-image.png");
    assert.ok(!briefs.some((b) => /brand primary|accent|#1a2b3c/i.test(b.name)));
    assert.ok(!briefs.some((b) => /brand primary|accent|#1a2b3c/i.test(b.prompt)));
  });

  it("isDatabasePhase requires affirmative DDL intent (not bare docker)", () => {
    const negation = `# Phase

## Scope
- Local-first persistence: IndexedDB via idb-keyval.
- No embedded ollama container / \`docker compose\` \`ollama:\` service / ollama-init.

## File Changes
- src/lib/graph/store.ts

## Success Criteria
Graph persists to IndexedDB.
`;
    assert.equal(isDatabasePhase(negation), false);

    const affirmative = `# Phase

## File Changes
- docker/init-db.sql — CREATE TABLE users

## Success Criteria
Database tables exist after migrate.
`;
    assert.equal(isDatabasePhase(affirmative), true);

    assert.equal(
      isDatabasePhase("Add postgres connection and schema migrations"),
      true,
    );
    assert.equal(
      isDatabasePhase("Use drizzle schema + migrate for accounts"),
      true,
    );
    assert.equal(
      isDatabasePhase("Mention docker compose briefly for app deploy only"),
      false,
    );
  });
});
