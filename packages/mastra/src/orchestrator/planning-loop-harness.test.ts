import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Agent } from "@mastra/core/agent";
import {
  readLatestDiagnosisForPhase,
  readPhaseDoc,
  validatePhaseDocForDev,
} from "@slopcontrol/artifacts";
import { LlmRegistry } from "@slopcontrol/llm";
import type { Phase, Project, Run } from "@slopcontrol/types";
import { ChangeOrchestrator, type OrchestratorAgents } from "./index.js";

/**
 * Planning-loop harness (no network, no real agents).
 *
 * Drives the real research → draft → judge legs with stub agents and a canned
 * judge queue, then asserts the loop machinery that failed phase 197:
 *   1. the judge receives the deterministic `Automated Check targets` block
 *      (existing paths grounded, File-Changes-declared paths marked NEW);
 *   2. a research-fault verdict is persisted and reaches the NEXT research
 *      prompt as numbered gaps (not silently dropped by a retry);
 *   3. a legitimate `|`-alternation grep is not rejected as a brittle chain;
 *   4. the loop converges to in_review once the draft satisfies the judge.
 */

const PHASE_ID = "01-demo";
const DESCRIPTION = "Add a status widget to the dashboard and prove it renders.";

const RESEARCH_MD = `# RESEARCH — Phase 01: status widget

Date: 2026-10-20

## Summary

The dashboard shell lives in \`src/dashboard.tsx\`; add the widget there.

## Relevant files

- \`src/dashboard.tsx\` — mount point
- \`tests/unit/widget.test.ts\` — new regression suite

## Check targets (verified)

- exists: src/dashboard.tsx
- exists: tests/unit/widget.test.ts
- exists: docs/llms-full.txt

RESEARCH_COMPLETE
`;

const RESEARCH_V2_MD = RESEARCH_MD.replace(
  "- exists: docs/llms-full.txt",
  '- exists: docs/llms-full.txt\n- literal string quoted: "status widget"',
);

const PHASE_MD = `# Phase 01 — Status widget

## Scope

Mount a status widget in the dashboard shell.

## File Changes

| Path | Action |
| --- | --- |
| src/dashboard.tsx | EDIT |
| tests/unit/widget.test.ts | NEW |

## Build Order

1. Export a \`StatusWidget\` component.
2. Mount it in \`src/dashboard.tsx\`.

## Success Criteria

- The dashboard renders \`StatusWidget\`.
- The regression suite passes and proves the render.

## Automated Checks

\`\`\`bash
set -euo pipefail
grep -qF 'StatusWidget' src/dashboard.tsx || exit 1
grep -qE 'AssertionError|expected .* to be|expected .* not to be' tests/unit/widget.test.ts || exit 1
npx vitest run tests/unit/widget.test.ts || exit 1
\`\`\`

## Blueprint Deltas

- **BD-01-1 — Dashboard widgets mount in the dashboard shell.** New widgets are composed in \`src/dashboard.tsx\`, never in the page router.

PHASE_COMPLETE
`;

/** Second-leg draft: judge-visible marker in Scope (any prompt variant sees it). */
const PHASE_MD_V2 = PHASE_MD.replace(
  "Mount a status widget in the dashboard shell.\n",
  "Mount a status widget in the dashboard shell. Widget state is read-only in v1.\n",
);

type JudgeVerdict = {
  ok: boolean;
  gaps?: string[];
  suggestedFixes?: string[];
  researchFaults?: string[];
  draftFaults?: string[];
};

type Captured = { system: string; user: string };

/** Minimal Agent stub: mirrors write_file + final text like the real agent. */
function stubAgent(
  onGenerate: (prompt: string) => string,
  calls: string[],
  writeTo?: string,
): Agent {
  const run = (prompt: string) => {
    calls.push(prompt);
    const text = onGenerate(prompt);
    if (writeTo) {
      mkdirSync(dirname(writeTo), { recursive: true });
      writeFileSync(writeTo, text);
    }
    return { text, finishReason: "stop" };
  };
  return {
    id: "stub",
    name: "Stub Agent",
    model: { defaultParams: { maxTokens: 8192 } },
    generate: async (prompt: string) => run(prompt),
    stream: async (prompt: string) => run(prompt),
  } as unknown as Agent;
}

function fakeRegistry(dir: string): LlmRegistry {
  const path = join(dir, "endpoints.json");
  writeFileSync(
    path,
    JSON.stringify({
      endpoints: [
        {
          id: "fake",
          label: "fake",
          baseUrl: "http://127.0.0.1:9/v1",
          apiType: "openai-chat",
          modelId: "fake-model",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "fake" },
        planning: { endpointId: "fake" },
        classification: { endpointId: "fake" },
        judge: { endpointId: "fake" },
        ask: { endpointId: "fake" },
        supervisor: { endpointId: "fake" },
        coding: { endpointId: "fake" },
        design: { endpointId: "fake" },
      },
    }),
    "utf-8",
  );
  return LlmRegistry.fromFile(path);
}

function chatReply(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify(content) },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Route LLM calls by system prompt. The phase-quality verdict is a function of
 * the DRAFT CONTENT (like a real judge), so transport retries — which resend
 * the prompt with an added "fix your JSON" note — get the same verdict.
 */
function installFetchStub(opts: {
  judge: (input: { user: string }) => JudgeVerdict;
  judgeCalls: Captured[];
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const messages = body.messages ?? [];
    const system =
      messages.find((m) => m.role === "system" || m.role === "developer")
        ?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";

    if (system.includes("PHASE.md quality judge")) {
      opts.judgeCalls.push({ system, user });
      return chatReply(opts.judge({ user }));
    }
    if (system.includes("Change Intent alignment judge")) {
      return chatReply({
        aligned: true,
        gaps: [],
        suggestedLines: [],
        faultLeg: "none",
      });
    }
    if (system.includes("RESEARCH.md quality judge")) {
      return chatReply({ ok: true, gaps: [], suggestedFixes: [] });
    }
    if (system.includes("RESEARCH.md explicitly contradicts")) {
      return chatReply({ conflicts: [] });
    }
    if (system.includes("classify a software change request")) {
      return chatReply({
        title: "Status widget",
        goal: DESCRIPTION,
        uiMount: "n/a",
        changeKind: "backend",
        needsInteraction: false,
        mustNot: [],
      });
    }
    // Dependency-intent classification fails open by design; give it a no-op.
    if (system.includes("classify operator messages about reusing")) {
      return chatReply({ dependencies: [] });
    }
    throw new Error(`unrouted LLM call: ${system.slice(0, 120)}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeProject(root: string): Project {
  return {
    id: "p1",
    name: "demo",
    rootPath: root,
    blueprintVersion: 1,
    createdAt: "",
    updatedAt: "",
  } as Project;
}

function makePhase(): Phase {
  return {
    id: PHASE_ID,
    title: "Status widget",
    description: DESCRIPTION,
  } as Phase;
}

function makeRun(): Run {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    phaseId: PHASE_ID,
    projectId: "p1",
    stage: "researching",
    iterationCount: 0,
    createdAt: now,
    updatedAt: now,
    stageTimings: [],
  } as Run;
}

function writeFixture(root: string): void {
  const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
  mkdirSync(join(phaseDir, "plan"), { recursive: true });
  mkdirSync(join(root, ".slopcontrol", "runs", "run-1"), { recursive: true });
  writeFileSync(
    join(root, ".slopcontrol", "BLUEPRINT.md"),
    "# Blueprint\n\nDashboard shell in src/dashboard.tsx.\n",
  );
  writeFileSync(
    join(phaseDir, "INTENT.json"),
    `${JSON.stringify(
      {
        title: "Status widget",
        goal: DESCRIPTION,
        uiMount: "n/a",
        changeKind: "backend",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: DESCRIPTION,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(phaseDir, "RESEARCH.md"), RESEARCH_MD);
  writeFileSync(
    join(phaseDir, "status.json"),
    `${JSON.stringify({ status: "draft" })}\n`,
  );
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "src", "dashboard.tsx"),
    "export function Dashboard() {\n  return <main />;\n}\n",
  );
  writeFileSync(join(root, "docs", "llms-full.txt"), "status widget\n");
}

/* ------------------------------------------------------------------ */
/* Rust pilot: cargo project through the same planning loop.           */
/* ------------------------------------------------------------------ */

const RUST_DESCRIPTION =
  "Add a replay module that counts re-sent packets and prove it with a targeted cargo test.";

const RUST_RESEARCH_MD = `# RESEARCH — Phase 01: replay counter

Date: 2026-10-22

## Summary

The parser API lives in \`src/lib.rs\`. A replay counter belongs in a new
\`src/replay.rs\` module re-exported from the crate root.

## Check targets (verified)

- exists: src/lib.rs
- exists: Cargo.toml

RESEARCH_COMPLETE
`;

const RUST_PHASE_MD = `# Phase 01 — Replay counter

## Scope

Add \`src/replay.rs\` with \`replay_count(&[Packet]) -> usize\` and re-export it from \`src/lib.rs\`.

## File Changes

| Path | Action |
| --- | --- |
| src/lib.rs | EDIT |
| src/replay.rs | NEW |

## Build Order

1. Create \`src/replay.rs\`.
2. Wire \`pub mod replay;\` in \`src/lib.rs\`.

## Success Criteria

- \`replay_count\` counts exact duplicate packets.
- A targeted cargo test proves the counter.

## Automated Checks

\`\`\`bash
set -euo pipefail
grep -q 'pub fn parse_packet' src/lib.rs || exit 1
grep -q 'pub mod replay' src/lib.rs || exit 1
grep -q 'pub fn replay_count' src/replay.rs || exit 1
cargo check || exit 1
cargo test replay_counter_counts -- --exact || exit 1
\`\`\`

## Blueprint Deltas

- **BD-01-1 — Feature logic lives in its own module**, re-exported from the crate root.

PHASE_COMPLETE
`;

function writeRustFixture(root: string): void {
  const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
  mkdirSync(join(phaseDir, "plan"), { recursive: true });
  mkdirSync(join(root, ".slopcontrol", "runs", "run-1"), { recursive: true });
  writeFileSync(
    join(root, ".slopcontrol", "BLUEPRINT.md"),
    "# Blueprint\n\nSingle-crate Rust library; modules re-exported from src/lib.rs.\n",
  );
  writeFileSync(
    join(phaseDir, "INTENT.json"),
    `${JSON.stringify(
      {
        title: "Replay counter",
        goal: RUST_DESCRIPTION,
        uiMount: "n/a",
        changeKind: "backend",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: RUST_DESCRIPTION,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(phaseDir, "RESEARCH.md"), RUST_RESEARCH_MD);
  writeFileSync(
    join(phaseDir, "status.json"),
    `${JSON.stringify({ status: "draft" })}\n`,
  );
  // Cargo project shape — toolchain detection keys off Cargo.toml (no
  // configured toolchain in config.json: the default-spec path).
  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "packetd"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "lib.rs"),
    "pub fn parse_packet(input: &str) -> Result<String, String> {\n    Ok(input.to_string())\n}\n",
  );
  // Declared conventions as onboarding would have extracted them.
  writeFileSync(
    join(root, ".slopcontrol", "CONVENTIONS.md"),
    "# Project verification conventions (declared)\n\n## AGENTS.md (verbatim)\n\nVerify changes with `cargo test <test_name> -- --exact`.\n",
  );
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("planning loop harness: research ⇄ draft ⇄ judge", () => {
  it("carries research faults into the next research leg and converges", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-loop-"));
    const judgeCalls: Captured[] = [];
    const restore = installFetchStub({
      judgeCalls,
      judge: ({ user }) =>
        user.includes("Widget state is read-only")
          ? { ok: true, gaps: [], suggestedFixes: [], researchFaults: [], draftFaults: [] }
          : {
              ok: false,
              gaps: [
                "RESEARCH does not quote docs/llms-full.txt wording, so the doc check is ungrounded",
              ],
              suggestedFixes: ["Quote the exact doc string in RESEARCH"],
              researchFaults: ["RESEARCH does not quote docs/llms-full.txt wording"],
              draftFaults: [],
            },
    });

    const researchCalls: string[] = [];
    const plannerCalls: string[] = [];
    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          researchAgent: stubAgent(
            () => RESEARCH_V2_MD,
            researchCalls,
            join(phaseDir, "RESEARCH.md"),
          ),
          phasePlannerAgent: stubAgent(
            () =>
              plannerCalls.length <= 1 ? PHASE_MD : PHASE_MD_V2,
            plannerCalls,
            join(phaseDir, "PHASE.md"),
          ),
        } as unknown as OrchestratorAgents,
      });

      // Leg 1: the judge rejects the draft and blames RESEARCH.
      const first = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(first, "failed", "research-fault verdict must fail the leg");

      const diagnosis = readLatestDiagnosisForPhase(root, PHASE_ID);
      assert.ok(diagnosis, "draft failure must persist a diagnosis");
      assert.ok(
        (diagnosis!.issues ?? []).some((i) => i.includes("llms-full.txt")),
        `diagnosis must keep the structured gap, got: ${JSON.stringify(diagnosis!.issues)}`,
      );

      // Leg 2: research re-run must inherit those gaps.
      await orchestrator.startResearch({
        project,
        phase,
        run,
        description: DESCRIPTION,
        force: true,
      });
      assert.ok(researchCalls.length >= 1, "research agent should run once");
      const researchPrompt = researchCalls[0] ?? "";
      assert.match(researchPrompt, /PRIOR PLANNING GATE FEEDBACK/);
      assert.match(researchPrompt, /RESEARCH does not quote docs\/llms-full\.txt wording/);
      assert.match(researchPrompt, /## Check targets \(verified\)/);

      // Leg 3: the re-drafted PHASE satisfies the judge → in_review.
      const second = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(second, "in_review", "loop must converge, not exhaust rounds");

      // 1. Judge saw the deterministic target-existence block.
      assert.ok(judgeCalls.length >= 2, `expected ≥2 judge calls, got ${judgeCalls.length}`);
      const firstJudgeUser = judgeCalls[0]?.user ?? "";
      assert.match(firstJudgeUser, /Automated Check targets \(verified by SlopControl/);
      assert.match(firstJudgeUser, /- exists: src\/dashboard\.tsx/);
      assert.match(firstJudgeUser, /- NEW: tests\/unit\/widget\.test\.ts/);
      assert.doesNotMatch(firstJudgeUser, /Widget state is read-only/);
      // First judgement has no priors — no convergence block.
      assert.doesNotMatch(firstJudgeUser, /already rejected an earlier draft/);

      // 1b. A re-research leg invalidates the convergence seed: the old gap
      // was about RESEARCH facts that were regenerated, so the re-judged draft
      // must NOT be anchored on it (the gap still drove the research prompt).
      const reJudgements = judgeCalls.filter((c) =>
        c.user.includes("Widget state is read-only"),
      );
      assert.ok(reJudgements.length >= 1, "re-drafted PHASE must be judged");
      for (const call of reJudgements) {
        assert.doesNotMatch(call.user, /already rejected an earlier draft/);
        assert.doesNotMatch(
          call.user,
          /RESEARCH does not quote docs\/llms-full\.txt wording/,
        );
      }

      // The re-drafted document (not just its predecessor) reached the judge.
      assert.ok(
        judgeCalls.some((c) => c.user.includes("Widget state is read-only")),
        "re-drafted PHASE.md must be judged",
      );

      // 2. The alternation check survived the structural gate (no brittle false positive).
      const written = readPhaseDoc(root, PHASE_ID) ?? "";
      assert.match(written, /AssertionError\|expected \.\* to be/);
      const gate = validatePhaseDocForDev(written);
      assert.equal(gate.ok, true, `structural gate rejected the draft: ${gate.issues.join("; ")}`);
      assert.ok(
        !gate.issues.some((i) => /Brittle Automated Check/i.test(i)),
        gate.issues.join("; "),
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grounds disk-real grep tokens deterministically instead of escalating to research", async () => {
    // Phase-29 grounding loop: the judge failed BRE-paren/dot tokens
    // (`isReadyMessage(event.data)`) as "never quoted in RESEARCH.md", each
    // miss routing to a full research rerun until the budget died. The
    // verified-tokens block must let the judge pass them in one draft leg.
    const root = mkdtempSync(join(tmpdir(), "planning-loop-grounded-"));
    const judgeCalls: Captured[] = [];
    const restore = installFetchStub({
      judgeCalls,
      judge: ({ user }) =>
        user.includes("## Verified grep tokens") &&
        user.includes("isReadyMessage(event.data)")
          ? { ok: true, gaps: [], suggestedFixes: [], researchFaults: [], draftFaults: [] }
          : {
              ok: false,
              gaps: [
                "RESEARCH.md never quotes the listener strings the checks grep for",
              ],
              suggestedFixes: ["Quote the exact strings in RESEARCH.md"],
              researchFaults: [
                "RESEARCH.md never quotes the listener strings the checks grep for",
              ],
              draftFaults: [],
            },
    });

    const ISLAND_PHASE_MD = `# Phase 01 — Consent-mandatory navigation

## Scope

Remove the silent timer redirect from the sign-in island.

## File Changes

| Path | Action |
| --- | --- |
| src/island.tsx | EDIT |

## Success Criteria

- Navigation only happens on an explicit click.

## Automated Checks

\`\`\`bash
set -euo pipefail
grep -q 'isReadyMessage(event.data)' src/island.tsx || exit 1
grep -q 'window.addEventListener("message", onMessage)' src/island.tsx || exit 1
\`\`\`

## Blueprint Deltas

- **BD-01-1 — Detection stays.** The ready-listener is untouched.

PHASE_COMPLETE
`;

    const researchCalls: string[] = [];
    const plannerCalls: string[] = [];
    try {
      writeFixture(root);
      // The island file exists with the exact strings, but RESEARCH.md (from
      // writeFixture) never quotes them.
      writeFileSync(
        join(root, "src", "island.tsx"),
        "const onMessage = (event: MessageEvent) => {\n" +
          "  if (!isReadyMessage(event.data)) return;\n" +
          "};\n" +
          'window.addEventListener("message", onMessage);\n',
      );
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          researchAgent: stubAgent(
            () => RESEARCH_V2_MD,
            researchCalls,
            join(phaseDir, "RESEARCH.md"),
          ),
          phasePlannerAgent: stubAgent(
            () => ISLAND_PHASE_MD,
            plannerCalls,
            join(phaseDir, "PHASE.md"),
          ),
        } as unknown as OrchestratorAgents,
      });

      const result = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(
        result,
        "in_review",
        "disk-real tokens must ground in the first draft leg — no research-fault escalation",
      );
      assert.equal(
        researchCalls.length,
        0,
        "no research rerun may be triggered by disk-verified tokens",
      );
      assert.ok(judgeCalls.length >= 1, "judge must see the draft");
      const firstJudge = judgeCalls[0]!;
      assert.match(firstJudge.user, /## Verified grep tokens/);
      assert.match(firstJudge.user, /isReadyMessage\(event\.data\)/);
      assert.match(firstJudge.user, /window\.addEventListener/);
      assert.match(
        firstJudge.system,
        /Verified grep tokens.*confirmed verbatim on disk/s,
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("research self-heal regen prompt carries the verbatim-quote instruction", async () => {
    // When the judge flags "check greps a string RESEARCH never quoted", the
    // regen leg must be told to quote that exact string and to preserve the
    // prior doc's other quotes — otherwise each round fixes one gap and drops
    // or misses the next (the phase-29 loop shape).
    const root = mkdtempSync(join(tmpdir(), "planning-loop-regen-"));
    const judgeCalls: Captured[] = [];
    // Content-based verdict (harness contract: transport retries resend the
    // prompt and must get the same verdict): fail while the judged draft
    // lacks the v2 marker, pass once the re-draft carries it.
    const restore = installFetchStub({
      judgeCalls,
      judge: ({ user }) =>
        user.includes("Widget state is read-only")
          ? { ok: true, gaps: [], suggestedFixes: [], researchFaults: [], draftFaults: [], resolvedGaps: [] }
          : {
              ok: false,
              gaps: ["RESEARCH never quotes the listener string a check greps"],
              suggestedFixes: ["Quote the exact string in RESEARCH.md"],
              researchFaults: [
                "RESEARCH never quotes the listener string a check greps",
              ],
              draftFaults: [],
              resolvedGaps: [],
            },
    });

    const researchCalls: string[] = [];
    const plannerCalls: string[] = [];
    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          researchAgent: stubAgent(
            () => RESEARCH_MD,
            researchCalls,
            join(phaseDir, "RESEARCH.md"),
          ),
          phasePlannerAgent: stubAgent(
            () => (plannerCalls.length <= 1 ? PHASE_MD : PHASE_MD_V2),
            plannerCalls,
            join(phaseDir, "PHASE.md"),
          ),
        } as unknown as OrchestratorAgents,
      });

      const result = await orchestrator.startResearch({
        project,
        phase,
        run,
        description: DESCRIPTION,
        force: true,
      });
      assert.equal(result, "in_review", "one regen round must converge");

      const regenPrompt = researchCalls.find((p) =>
        p.includes("Regenerate the FULL RESEARCH.md from scratch"),
      );
      assert.ok(regenPrompt, "research-fault verdict must trigger a regen leg");
      assert.match(regenPrompt!, /RESEARCH never quotes the listener string/);
      assert.match(regenPrompt!, /verbatim-quote that exact string/);
      assert.match(regenPrompt!, /## Check targets \(verified\)/);
      assert.match(regenPrompt!, /Preserve every other quoted string/);
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops gaps the judge resolved and carries only the unresolved ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-converge-"));
    const judgeCalls: Captured[] = [];
    const gapA =
      "File Changes never declares the Verdict line the evidence check requires";
    const gapB =
      "The mount sentinel uses head -n1 and cannot prove 'mounted exactly once'";

    const v2 = PHASE_MD.replace(
      "Mount a status widget in the dashboard shell.\n",
      "Mount a status widget in the dashboard shell. Widget state is read-only in v1.\n",
    );
    const v3 = v2.replace(
      "Widget state is read-only in v1.\n",
      "Widget state is read-only in v1. Sentinels are count-exact.\n",
    );

    const restore = installFetchStub({
      judgeCalls,
      judge: ({ user }) => {
        if (user.includes("Sentinels are count-exact")) {
          return {
            ok: true,
            gaps: [],
            suggestedFixes: [],
            resolvedGaps: [gapB],
            researchFaults: [],
            draftFaults: [],
          };
        }
        if (user.includes("Widget state is read-only")) {
          return {
            ok: false,
            gaps: [gapB],
            suggestedFixes: ["Assert an exact match count"],
            resolvedGaps: [gapA],
            researchFaults: [],
            draftFaults: [gapB],
          };
        }
        return {
          ok: false,
          gaps: [gapA],
          suggestedFixes: ["Declare the Verdict line"],
          resolvedGaps: [],
          researchFaults: [],
          draftFaults: [gapA],
        };
      },
    });

    const plannerCalls: string[] = [];
    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const variants = [PHASE_MD, v2, v3];
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          researchAgent: stubAgent(() => RESEARCH_MD, [], join(phaseDir, "RESEARCH.md")),
          phasePlannerAgent: stubAgent(
            () => variants[Math.min(plannerCalls.length - 1, variants.length - 1)]!,
            plannerCalls,
            join(phaseDir, "PHASE.md"),
          ),
        } as unknown as OrchestratorAgents,
      });

      const stage = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(stage, "in_review", "a resolved gap must let the leg converge");

      // One judgement is fetched several times by the transport ladder, so
      // select by document marker (V2 / V3) rather than by call index.
      const judgedV2 = judgeCalls.find((c) =>
        c.user.includes("Widget state is read-only"),
      );
      const judgedV3 = judgeCalls.find((c) =>
        c.user.includes("Sentinels are count-exact"),
      );
      assert.ok(judgedV2, "the retried draft must be judged");
      assert.ok(judgedV3, "the second retried draft must be judged");

      // Second judgement: gap A is prior context and must be verified.
      assert.match(judgedV2!.user, /already rejected an earlier draft/);
      assert.ok(judgedV2!.user.includes(gapA), "gap A must be prior context");

      // Third judgement: A was resolved and must not be re-seeded; B still is.
      assert.match(judgedV3!.user, /already rejected an earlier draft/);
      assert.ok(judgedV3!.user.includes(gapB), "unresolved gap B must be prior context");
      assert.ok(
        !judgedV3!.user.includes(gapA),
        "resolved gap A must not be re-asserted",
      );

      const log = readFileSync(join(root, ".slopcontrol", "runs", "run-1", "log.txt"), "utf8");
      assert.match(log, /Phase quality judge resolved prior gaps/);
      assert.ok(log.includes(gapA), "resolved gaps are logged for observability");
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accumulates a silently-dropped gap across the within-leg retry loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-loop-accumulate-"));
    const judgeCalls: Captured[] = [];
    const gapA = "File Changes never declares the Verdict line";
    const gapB = "The mount sentinel cannot prove count-exact mounting";

    const v2 = PHASE_MD.replace(
      "Mount a status widget in the dashboard shell.\n",
      "Mount a status widget in the dashboard shell. Widget state is read-only in v1.\n",
    );
    const v3 = v2.replace(
      "Widget state is read-only in v1.\n",
      "Widget state is read-only in v1. Sentinels are count-exact.\n",
    );

    // Judgement 2 raises a NEW gap B WITHOUT resolving or re-raising gap A —
    // the within-leg loop must accumulate A + B, not forget A.
    const restore = installFetchStub({
      judgeCalls,
      judge: ({ user }) => {
        if (user.includes("Sentinels are count-exact")) {
          return {
            ok: true,
            gaps: [],
            suggestedFixes: [],
            resolvedGaps: [gapA, gapB],
            researchFaults: [],
            draftFaults: [],
          };
        }
        if (user.includes("Widget state is read-only")) {
          return {
            ok: false,
            gaps: [gapB],
            suggestedFixes: ["Assert exact count"],
            resolvedGaps: [],
            researchFaults: [],
            draftFaults: [gapB],
          };
        }
        return {
          ok: false,
          gaps: [gapA],
          suggestedFixes: ["Declare the Verdict line"],
          resolvedGaps: [],
          researchFaults: [],
          draftFaults: [gapA],
        };
      },
    });

    const plannerCalls: string[] = [];
    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const variants = [PHASE_MD, v2, v3];
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          phasePlannerAgent: stubAgent(
            () => variants[Math.min(plannerCalls.length - 1, variants.length - 1)]!,
            plannerCalls,
            join(phaseDir, "PHASE.md"),
          ),
        } as unknown as OrchestratorAgents,
      });

      const stage = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(stage, "in_review", "the leg must converge");

      const judgedV3 = judgeCalls.find((c) =>
        c.user.includes("Sentinels are count-exact"),
      );
      assert.ok(judgedV3, "the final re-draft must be judged");
      // gapA was never resolved nor re-raised — it must still be prior context.
      assert.ok(
        judgedV3!.user.includes(gapA),
        "a silently-dropped gap must survive to the next judgement",
      );
      assert.ok(
        judgedV3!.user.includes(gapB),
        "the latest gap must also be prior context",
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-seeds research gaps on same content (mtime churn must not false-drop)", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-ledger-reseed-"));
    const judgeCalls: Captured[] = [];
    const gapDraft = "Check 7 uses bare npm test without a path";
    const gapResearch = "RESEARCH does not quote the exact doc string";

    const restore = installFetchStub({
      judgeCalls,
      judge: () => ({
        ok: false,
        gaps: [gapResearch, gapDraft],
        researchFaults: [gapResearch],
        draftFaults: [gapDraft],
        resolvedGaps: [],
      }),
    });

    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          phasePlannerAgent: stubAgent(() => PHASE_MD, [], join(phaseDir, "PHASE.md")),
        } as unknown as OrchestratorAgents,
      });

      const first = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(first, "failed");
      const diagnosis = readLatestDiagnosisForPhase(root, PHASE_ID);
      assert.ok(diagnosis?.researchHash, "ledger diagnosis must stamp researchHash");

      // Touch RESEARCH.md with the SAME bytes (mtime churn, no content change).
      const researchPath = join(phaseDir, "RESEARCH.md");
      const sameContent = readFileSync(researchPath, "utf8");
      writeFileSync(researchPath, sameContent);

      const second = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(second, "failed");

      // Same content → research gap is RE-SEEDED (not false-dropped).
      const reJudgement = judgeCalls[judgeCalls.length - 1]?.user ?? "";
      assert.ok(
        reJudgement.includes(gapResearch),
        "same-content research gap must be re-seeded",
      );
      assert.ok(reJudgement.includes(gapDraft), "draft gap must be re-seeded");
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a judge-resolved gap is NOT resurrected by the next write", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-ledger-resurrection-"));
    const judgeCalls: Captured[] = [];
    const gapA = "File Changes never declares the Verdict line";
    const gapB = "The mount sentinel cannot prove count-exact mounting";

    const restore = installFetchStub({
      judgeCalls,
      judge: ({ user }) => {
        const seenA = user.includes(gapA);
        return seenA
          ? { ok: false, gaps: [gapB], researchFaults: [], draftFaults: [gapB], resolvedGaps: [gapA] }
          : { ok: false, gaps: [gapA], researchFaults: [], draftFaults: [gapA], resolvedGaps: [] };
      },
    });

    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          phasePlannerAgent: stubAgent(() => PHASE_MD, [], join(phaseDir, "PHASE.md")),
        } as unknown as OrchestratorAgents,
      });

      await orchestrator.draftPhase({ project, phase, run });
      await orchestrator.draftPhase({ project, phase, run });

      const persisted = readLatestDiagnosisForPhase(root, PHASE_ID);
      assert.ok(persisted, "phase diagnosis must persist");
      assert.ok(
        persisted!.openIssues?.includes(gapB),
        "the unresolved second gap must persist",
      );
      assert.ok(
        !persisted!.openIssues?.includes(gapA),
        "the judge-resolved gap must NOT be resurrected by write-time union",
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("infra-text never enters the ledger (phase-197 anchoring stays closed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-ledger-infra-"));
    const judgeCalls: Captured[] = [];
    const gapContent = "Check 7 uses bare npm test without a path";

    const restore = installFetchStub({
      judgeCalls,
      judge: ({ user }) =>
        user.includes("already rejected an earlier draft")
          ? { ok: false, gaps: [gapContent], researchFaults: [], draftFaults: [gapContent], resolvedGaps: [] }
          : {
              ok: false,
              gaps: ["expected object, received array"],
              researchFaults: [],
              draftFaults: [],
              resolvedGaps: [],
            },
    });

    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          phasePlannerAgent: stubAgent(() => PHASE_MD, [], join(phaseDir, "PHASE.md")),
        } as unknown as OrchestratorAgents,
      });

      await orchestrator.draftPhase({ project, phase, run });
      const persisted = readLatestDiagnosisForPhase(root, PHASE_ID);
      assert.ok(persisted, "phase diagnosis must persist");
      assert.ok(
        !(persisted!.draftIssues ?? []).some((g) => g.includes("expected object")),
        "transport-shaped text must not enter the draft ledger",
      );
      assert.ok(
        !(persisted!.openIssues ?? []).some((g) => g.includes("expected object")),
        "transport-shaped text must not enter the open-issue ledger",
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retry_draft after budget exhaustion resets researchReruns but keeps the ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-budget-reset-"));
    const restore = installFetchStub({
      judgeCalls: [],
      judge: () => ({
        ok: false,
        gaps: ["Check 7 uses bare npm test without a path"],
        researchFaults: [],
        draftFaults: ["Check 7 uses bare npm test without a path"],
        resolvedGaps: [],
      }),
    });
    try {
      writeFixture(root);
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      // Pad RESEARCH.md past the 400-char researchLooksSolid threshold (the
      // harness fixture is intentionally terse and is never retry_draft'd).
      writeFileSync(join(phaseDir, "RESEARCH.md"), `${RESEARCH_MD}\n${"evidence note\n".repeat(4)}`);
      // Seed a wedged phase: budget exhausted + an accumulated ledger.
      writeFileSync(
        join(phaseDir, "diagnosis.json"),
        `${JSON.stringify({
          audience: "coding",
          operatorActions: [],
          class: "process",
          confidence: "high",
          title: "Research budget exhausted",
          rootCause: "x",
          evidence: "x",
          nextActions: "Retry draft.",
          fingerprint: "planning-research-budget-abc",
          codingAgentShouldFix: true,
          tags: ["planning", "research", "research-budget"],
          issues: ["Check 7 uses bare npm test without a path"],
          openIssues: ["Check 7 uses bare npm test without a path"],
          draftIssues: ["Check 7 uses bare npm test without a path"],
          researchReruns: 3,
          phaseId: PHASE_ID,
          runId: "run-1",
          updatedAt: "2026-10-22T00:00:00.000Z",
        })}\n`,
      );

      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          phasePlannerAgent: stubAgent(() => PHASE_MD, [], join(phaseDir, "PHASE.md")),
        } as unknown as OrchestratorAgents,
      });

      // retry_draft must reset the budget (operator intent) and preserve the ledger.
      await orchestrator.retryDraft({ project, phase, run });
      const persisted = readLatestDiagnosisForPhase(root, PHASE_ID);
      assert.ok(persisted, "phase diagnosis must persist after retry_draft");
      assert.equal(persisted!.researchReruns, 0, "budget was reset by retry_draft");
      assert.ok(
        (persisted!.openIssues ?? []).some((g) => g.includes("npm test")),
        "ledger must survive the retry",
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries a draft-mechanics gap across a research re-run via the open-issue ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-ledger-"));
    const judgeCalls: Captured[] = [];
    const gapDraft = "Check 7 uses bare npm test without a path";
    const gapResearch = "RESEARCH does not quote the exact doc string";

    // A "both" fault returns immediately (no within-leg re-draft retry), so
    // each draftPhase yields exactly one judge call.
    const restore = installFetchStub({
      judgeCalls,
      judge: () => ({
        ok: false,
        gaps: [gapResearch, gapDraft],
        researchFaults: [gapResearch],
        draftFaults: [gapDraft],
        resolvedGaps: [],
      }),
    });

    try {
      writeFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          phasePlannerAgent: stubAgent(() => PHASE_MD, [], join(phaseDir, "PHASE.md")),
        } as unknown as OrchestratorAgents,
      });

      // Leg 1: draft fault → diagnosis persists the ledger with attribution split.
      const first = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(first, "failed");
      const diagnosis = readLatestDiagnosisForPhase(root, PHASE_ID);
      assert.ok(diagnosis, "draft failure must persist a diagnosis");
      assert.deepEqual(
        diagnosis!.researchIssues,
        [gapResearch],
        "research-attributed gap must be persisted on the ledger",
      );
      assert.deepEqual(
        diagnosis!.draftIssues,
        [gapDraft],
        "draft-attributed gap must be persisted on the ledger",
      );
      assert.ok(
        (diagnosis!.openIssues ?? []).includes(gapDraft),
        "openIssues is the union of the attribution buckets",
      );

      // Leg 2: regenerate RESEARCH.md directly (newer mtime than the verdict),
      // then re-draft. Bypasses startResearch so we exercise the cross-run
      // ledger (persisted diagnosis → next draftPhase seed), not the in-memory
      // self-heal outcome.
      writeFileSync(join(phaseDir, "RESEARCH.md"), RESEARCH_V2_MD);
      const second = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(second, "failed");

      // The re-judgement seeds the draft gap (survived research regen) but drops
      // the research gap (its facts were regenerated).
      const reJudgement = judgeCalls[judgeCalls.length - 1]?.user ?? "";
      assert.match(reJudgement, /already rejected an earlier draft/);
      assert.ok(reJudgement.includes(gapDraft), "draft gap must survive research regen");
      assert.ok(
        !reJudgement.includes(gapResearch),
        "research gap must be dropped once RESEARCH was regenerated",
      );
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rust pilot: drafter and judge both receive cargo vocabulary, converges to in_review", async () => {
    const root = mkdtempSync(join(tmpdir(), "planning-rust-"));
    const judgeCalls: Captured[] = [];
    const restore = installFetchStub({
      judgeCalls,
      judge: () => ({
        ok: true,
        gaps: [],
        suggestedFixes: [],
        researchFaults: [],
        draftFaults: [],
      }),
    });

    const plannerCalls: string[] = [];
    try {
      writeRustFixture(root);
      const project = makeProject(root);
      const phase = makePhase();
      const run = makeRun();
      const phaseDir = join(root, ".slopcontrol", "phases", PHASE_ID);
      const orchestrator = new ChangeOrchestrator({
        dataDir: root,
        registry: fakeRegistry(root),
        agents: {
          researchAgent: stubAgent(() => RUST_RESEARCH_MD, []),
          phasePlannerAgent: stubAgent(
            () => RUST_PHASE_MD,
            plannerCalls,
            join(phaseDir, "PHASE.md"),
          ),
        } as unknown as OrchestratorAgents,
      });

      const stage = await orchestrator.draftPhase({ project, phase, run });
      assert.equal(stage, "in_review", `rust draft must pass the loop`);

      // Drafter prompt: cargo vocabulary from the detected toolchain, no
      // node-estate commands, and the project's declared conventions cited.
      const draftPrompt = plannerCalls[0] ?? "";
      assert.match(draftPrompt, /cargo test <test_name>/);
      assert.match(draftPrompt, /cargo check/);
      assert.match(draftPrompt, /The project's declared conventions/);
      assert.doesNotMatch(draftPrompt, /npx vitest run/);
      // UI guards are node-web-only — no estate shell/mock vocabulary leaks.
      assert.doesNotMatch(draftPrompt, /Shared shell regression guard|Menubar|App\.tsx|\.env-pane/);

      // Judge: the toolchain-aware §4 (judges against the embedded rules
      // block) and the rendered cargo rules embedded in the user message.
      assert.ok(judgeCalls.length >= 1, "phase-quality judge must run");
      const judgeSystem = judgeCalls[0]!.system;
      const judgeUser = judgeCalls[0]!.user;
      assert.match(judgeSystem, /project's check-authoring rules/);
      assert.doesNotMatch(judgeSystem, /grep\/build\/vitest one-shot/);
      assert.match(judgeUser, /cargo test <test_name>/);
      assert.doesNotMatch(judgeUser, /npx vitest run/);
      // Deterministic targets block is ecosystem-agnostic: exists + NEW.
      assert.match(judgeUser, /- exists: src\/lib\.rs/);
      assert.match(judgeUser, /- NEW: src\/replay\.rs/);
      // No test-services and no compose file → self-contained probe rule,
      // not the managed-infra ban.
      assert.match(judgeUser, /self-contained/);
      assert.doesNotMatch(judgeUser, /verify already brings up test-services/);

      // The draft on disk passed the structural gate.
      const written = readPhaseDoc(root, PHASE_ID) ?? "";
      const gate = validatePhaseDocForDev(written, { projectRoot: root });
      assert.equal(gate.ok, true, gate.issues.join("; "));
    } finally {
      restore();
      globalThis.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
