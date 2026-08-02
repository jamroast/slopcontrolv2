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
  createAskSubResearchAgent,
  createDesignLoopAgent,
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
