import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { LlmRegistry } from "@slopcontrol/llm";
import { ASK_SUB_RESEARCH_MAX_TOPICS } from "@slopcontrol/types";
import {
  createAgentChatAgent,
  createAskAgent,
  createPlanLoopAgent,
  createPlanLoopRepairAgent,
  createAskSubResearchAgent,
  createDesignLoopAgent,
  createDevSupervisorAgent,
  createPhasePlannerAgent,
  createResearchAgent,
} from "./index.js";

function testRegistry(dir: string): LlmRegistry {
  const path = join(dir, "endpoints.json");
  writeFileSync(
    path,
    JSON.stringify({
      endpoints: [
        {
          id: "local",
          baseUrl: "http://127.0.0.1:9/v1",
          apiType: "openai-chat",
          modelId: "test-model",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "local" },
        planning: { endpointId: "local" },
        design: { endpointId: "local" },
        supervisor: { endpointId: "local" },
        coding: { endpointId: "local" },
      },
    }),
    "utf-8",
  );
  return LlmRegistry.fromFile(path);
}

describe("ask / agent chat tool split", () => {
  it("caps sub-research topics at ASK_SUB_RESEARCH_MAX_TOPICS", () => {
    assert.equal(ASK_SUB_RESEARCH_MAX_TOPICS, 4);
  });

  it("ask and sub-research omit run_command; agent chat includes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-agents-"));
    try {
      const registry = testRegistry(dir);
      const storage = new LibSQLStore({
        id: "test-storage",
        url: `file:${join(dir, "mastra.db")}`,
      });
      const memory = new Memory({
        storage,
        options: { lastMessages: 5 },
      });
      const projectDir = join(dir, "proj");

      const ask = createAskAgent(registry, projectDir, memory);
      const sub = createAskSubResearchAgent(registry, projectDir, memory);
      const agent = createAgentChatAgent(registry, projectDir, memory);
      const designLoop = createDesignLoopAgent(registry, projectDir, memory);
      const planLoop = createPlanLoopAgent(registry, projectDir, memory);

      const askTools = await ask.listTools();
      const subTools = await sub.listTools();
      const agentTools = await agent.listTools();
      const loopTools = await designLoop.listTools();
      const planTools = await planLoop.listTools();

      assert.equal("run_command" in askTools, false);
      assert.equal("write_file" in askTools, false);
      assert.equal("run_command" in subTools, false);
      assert.equal("write_file" in subTools, false);
      assert.equal("run_command" in agentTools, true);
      assert.equal("write_file" in agentTools, false);
      assert.equal("write_file" in loopTools, false);
      assert.equal("run_command" in loopTools, false);
      assert.equal("grep_files" in loopTools, false);
      assert.equal("list_files" in loopTools, false);
      assert.ok("read_file" in askTools);
      assert.ok("grep_files" in subTools);
      assert.equal("read_file" in loopTools, false);
      assert.ok("generate_image" in loopTools);
      assert.ok("pin_logo" in loopTools);
      assert.ok("make_transparent" in loopTools);
      assert.ok("edit_image" in loopTools);
      assert.ok("circular_mask" in loopTools);
      assert.ok("derive_icon_pack" in loopTools);
      assert.ok("resize_image" in loopTools);
      assert.ok("search_images" in loopTools);
      assert.ok("import_image" in loopTools);
      assert.ok("review_look" in loopTools);
      assert.ok("read_file" in planTools);
      assert.ok("grep_files" in planTools);
      assert.equal("run_command" in planTools, false);
      assert.equal("write_file" in planTools, false);
      assert.equal("generate_image" in planTools, false);

      const supervisor = createDevSupervisorAgent(registry, projectDir, memory);
      const supervisorTools = await supervisor.listTools();
      assert.equal("run_command" in supervisorTools, false);
      assert.equal("write_file" in supervisorTools, false);
      assert.equal("read_file" in supervisorTools, false);
      assert.equal("list_files" in supervisorTools, false);
      // Curated enrich: no Memory / OM (memory:false generate must not need threadId)
      assert.equal(
        (supervisor as { memory?: unknown }).memory,
        undefined,
        "supervisor must not attach shared Memory with ObservationalMemory",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("research and planner instructions cover Vite resolve claim-vs-proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-agents-vite-"));
    try {
      const registry = testRegistry(dir);
      const storage = new LibSQLStore({
        id: "test-storage-vite",
        url: `file:${join(dir, "mastra.db")}`,
      });
      const memory = new Memory({
        storage,
        options: { lastMessages: 5 },
      });
      const research = createResearchAgent(registry, join(dir, "proj"), memory);
      const planner = createPhasePlannerAgent(
        registry,
        join(dir, "proj"),
        memory,
      );
      const researchInstr = String(
        await (
          research as { getInstructions: () => Promise<string> | string }
        ).getInstructions(),
      );
      const plannerInstr = String(
        await (
          planner as { getInstructions: () => Promise<string> | string }
        ).getInstructions(),
      );
      assert.match(researchInstr, /prefix order|first matching alias/i);
      assert.match(researchInstr, /vite build|resolveId/i);
      assert.match(plannerInstr, /finite resolve proof|vite build/i);
      assert.match(plannerInstr, /Grep-for-alias|insufficient/i);
      assert.match(researchInstr, /Mounted ≠ visible|@source/i);
      assert.match(plannerInstr, /style visibility|Mounted ≠ visible/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ask agent instructions include tool budget and answer-early rule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-agents-ask-"));
    try {
      const registry = testRegistry(dir);
      const storage = new LibSQLStore({
        id: "test-storage-ask-budget",
        url: `file:${join(dir, "mastra.db")}`,
      });
      const memory = new Memory({
        storage,
        options: { lastMessages: 5 },
      });
      const ask = createAskAgent(registry, join(dir, "proj"), memory);
      const instr = String(
        await (
          ask as { getInstructions: () => Promise<string> | string }
        ).getInstructions(),
      );
      assert.match(instr, /Tool budget|6–8|6-8/i);
      assert.match(instr, /answer immediately/i);
      assert.match(instr, /BLUEPRINT archaeology/i);
      assert.match(instr, /not appearing|invisible|can't see/i);
      assert.match(instr, /style visibility|@source/i);
      assert.match(instr, /Confirm \*\*mount\*\*|Confirm mount/i);
      assert.match(instr, /click navigates to route X/i);
      assert.match(instr, /Intent engagement is only for fill\/submit/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plan-loop emit rule and repair agent has no tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-agents-plan-"));
    try {
      const registry = testRegistry(dir);
      const storage = new LibSQLStore({
        id: "test-storage-plan",
        url: `file:${join(dir, "mastra.db")}`,
      });
      const memory = new Memory({
        storage,
        options: { lastMessages: 5 },
      });
      const plan = createPlanLoopAgent(registry, join(dir, "proj"), memory);
      const repair = createPlanLoopRepairAgent(registry, memory);
      const planInstr = String(
        await (
          plan as { getInstructions: () => Promise<string> | string }
        ).getInstructions(),
      );
      assert.match(planInstr, /CRITICAL emit rule|Never end a turn without/i);
      assert.match(planInstr, /exhaustive sibling|step budget/i);
      assert.match(planInstr, /chat-facing summary/i);
      assert.match(planInstr, /not possible in the plan loop/i);
      const repairTools = await repair.listTools();
      assert.equal("read_file" in repairTools, false);
      assert.equal("list_files" in repairTools, false);
      assert.equal("grep_files" in repairTools, false);
      assert.equal(Object.keys(repairTools).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
