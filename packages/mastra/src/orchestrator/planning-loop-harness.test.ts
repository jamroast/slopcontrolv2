import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

      // 1b. Convergence memory: every re-draft judgement (the stub exercises
      // the whole transport ladder, so there are several) carries the
      // persisted gaps from the failed leg, with the objectively-fatal bar
      // for raising new ones.
      const reJudgements = judgeCalls.filter((c) =>
        c.user.includes("Widget state is read-only"),
      );
      assert.ok(reJudgements.length >= 1, "re-drafted PHASE must be judged");
      for (const call of reJudgements) {
        assert.match(call.user, /already rejected an earlier draft/);
        assert.match(
          call.user,
          /RESEARCH does not quote docs\/llms-full\.txt wording/,
        );
        assert.match(call.user, /objectively fatal/);
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
});
