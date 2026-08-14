import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { LlmRegistry } from "@slopcontrol/llm";
import type { Phase, Project, Run } from "@slopcontrol/types";
import { createJudgeAgent } from "../agents/index.js";
import type { DevelopJudgeVerdict } from "./ask-investigate.js";
import {
  ChangeOrchestrator,
  type AskTurnInput,
  type OrchestratorAgents,
} from "./index.js";

/** endpoints.json pointing at a dead port so judge turns fail fast. */
function deadRegistry(dir: string): LlmRegistry {
  const path = join(dir, "endpoints.json");
  writeFileSync(
    path,
    JSON.stringify({
      endpoints: [
        {
          id: "dead",
          baseUrl: "http://127.0.0.1:9/v1",
          apiType: "openai-chat",
          modelId: "dead-model",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "dead" },
        planning: { endpointId: "dead" },
        design: { endpointId: "dead" },
        supervisor: { endpointId: "dead" },
        coding: { endpointId: "dead" },
        ask: { endpointId: "dead" },
        judge: { endpointId: "dead" },
      },
    }),
    "utf-8",
  );
  return LlmRegistry.fromFile(path);
}

function makeProject(dir: string): Project {
  return {
    id: "p1",
    name: "demo",
    rootPath: dir,
    blueprintVersion: 0,
    createdAt: "",
    updatedAt: "",
  } as Project;
}

function makeRun(): Run {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    phaseId: "ph-1",
    projectId: "p1",
    stage: "developing",
    iterationCount: 1,
    createdAt: now,
    updatedAt: now,
    stageTimings: [],
  } as Run;
}

function makePhase(): Phase {
  return {
    id: "ph-1",
    title: "Settings page",
    description: "Add a settings page with profile fields.",
  } as Phase;
}

interface JudgeHarness {
  runAskJudge: (
    input: AskTurnInput,
    findings: string,
    dirtyWarning: string | null,
  ) => Promise<{ reply: string }>;
  runDevelopJudge: (input: {
    project: Project;
    run: Run;
    phase: Phase;
    phaseDoc: string;
    iteration: number;
    codingOutput: string;
    changedFiles: string[];
    abortSignal?: AbortSignal;
  }) => Promise<DevelopJudgeVerdict | null>;
  runDevelopCompletionJudge: (input: {
    project: Project;
    run: Run;
    phase: Phase;
    phaseDoc: string;
    changedFiles: string[];
    checksSummary: string;
    abortSignal?: AbortSignal;
  }) => Promise<DevelopJudgeVerdict | null>;
}

function makeOrchestrator(dir: string): JudgeHarness {
  const registry = deadRegistry(dir);
  const storage = new LibSQLStore({
    id: "judge-test-storage",
    url: `file:${join(dir, "mastra.db")}`,
  });
  const memory = new Memory({ storage, options: { lastMessages: 5 } });
  const judgeAgent = createJudgeAgent(registry, memory);
  const orchestrator = new ChangeOrchestrator({
    dataDir: dir,
    registry,
    agents: { judgeAgent } as unknown as OrchestratorAgents,
  });
  return orchestrator as unknown as JudgeHarness;
}

describe("judge fallbacks (judge turn fails)", () => {
  // An already-aborted signal makes runAgentLiveTurn throw instantly —
  // same catch contract as a dead endpoint, without the network wait.
  it("ask judge failure returns the raw investigation findings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-judge-"));
    try {
      const orch = makeOrchestrator(dir);
      const input: AskTurnInput = {
        project: makeProject(dir),
        askId: "ask-1",
        message: "does /product match the blueprint?",
        history: [],
        abortSignal: AbortSignal.abort(),
      };
      const out = await orch.runAskJudge(input, "RAW FINDINGS", null);
      assert.equal(out.reply, "RAW FINDINGS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ask judge failure with empty findings still yields a reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-judge-"));
    try {
      const orch = makeOrchestrator(dir);
      const input: AskTurnInput = {
        project: makeProject(dir),
        askId: "ask-1",
        message: "anything?",
        history: [],
        abortSignal: AbortSignal.abort(),
      };
      const out = await orch.runAskJudge(input, "  ", null);
      assert.equal(out.reply, "(empty reply)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coding-turn judge failure fails open to null (checks stay the gate)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-judge-"));
    try {
      const orch = makeOrchestrator(dir);
      const verdict = await orch.runDevelopJudge({
        project: makeProject(dir),
        run: makeRun(),
        phase: makePhase(),
        phaseDoc: "",
        iteration: 1,
        codingOutput: "implemented the settings page",
        changedFiles: ["src/app/settings/page.tsx"],
        abortSignal: AbortSignal.abort(),
      });
      assert.equal(verdict, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pre-merge judge failure fails open to null so the merge proceeds on green checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-judge-"));
    try {
      const orch = makeOrchestrator(dir);
      const verdict = await orch.runDevelopCompletionJudge({
        project: makeProject(dir),
        run: makeRun(),
        phase: makePhase(),
        phaseDoc: "",
        changedFiles: ["src/app/settings/page.tsx"],
        checksSummary: "build ok",
        abortSignal: AbortSignal.abort(),
      });
      assert.equal(verdict, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
