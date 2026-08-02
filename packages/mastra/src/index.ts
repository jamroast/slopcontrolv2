import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { LlmRegistry } from "@slopcontrol/llm";
import {
  createAskAgent,
  createAskSubResearchAgent,
  createAgentChatAgent,
  createBlueprintAgent,
  createDesignAgent,
  createDesignLoopAgent,
  createPlanLoopAgent,
  createDevSupervisorAgent,
  createPhasePlannerAgent,
  createResearchAgent,
  createReviewAgent,
} from "./agents/index.js";
import { ChangeOrchestrator } from "./orchestrator/index.js";

export interface SlopcontrolRuntime {
  mastra: Mastra;
  registry: LlmRegistry;
  memory: Memory;
  storage: LibSQLStore;
  orchestrator: ChangeOrchestrator;
  agents: {
    researchAgent: ReturnType<typeof createResearchAgent>;
    phasePlannerAgent: ReturnType<typeof createPhasePlannerAgent>;
    reviewAgent: ReturnType<typeof createReviewAgent>;
    designAgent: ReturnType<typeof createDesignAgent>;
    designLoopAgent: ReturnType<typeof createDesignLoopAgent>;
    planLoopAgent: ReturnType<typeof createPlanLoopAgent>;
    devSupervisorAgent: ReturnType<typeof createDevSupervisorAgent>;
    blueprintAgent: ReturnType<typeof createBlueprintAgent>;
    askAgent: ReturnType<typeof createAskAgent>;
    askSubResearchAgent: ReturnType<typeof createAskSubResearchAgent>;
    agentChatAgent: ReturnType<typeof createAgentChatAgent>;
  };
}

const runtimeCache = new Map<string, SlopcontrolRuntime>();

/**
 * Persistent Mastra memory on disk via LibSQL (SQLite file).
 * Path: {dataDir}/mastra.db — lightweight, no Postgres/Docker required.
 * Obsidian remains for human-readable project artifacts, not agent thread storage.
 */
export function createSlopcontrolMastra(
  dataDir: string,
  projectDir: string,
): SlopcontrolRuntime {
  mkdirSync(dataDir, { recursive: true });

  const registry = LlmRegistry.fromFile(join(dataDir, "endpoints.json"));

  const storage = new LibSQLStore({
    id: "slopcontrol-storage",
    url: `file:${join(dataDir, "mastra.db")}`,
  });

  // Observational Memory defaults to google/gemini-2.5-flash unless model is set.
  // Use the same configured supervisor endpoint (Ollama Cloud GLM, etc.).
  // If Memory fails at runtime, check: dataDir writable, mastra.db path, supervisor endpoint in endpoints.json.
  // Default Mastra OM windows are 30k message / 40k observation tokens — raise them so
  // long research/planning tool loops do not compact mid-turn on large-context models (e.g. glm-5.2 1M).
  let memoryModel;
  try {
    memoryModel = registry.resolve("supervisor");
  } catch (error) {
    throw new Error(
      `Mastra observationalMemory needs a resolvable supervisor endpoint (endpoints.json). ${
        error instanceof Error ? error.message : String(error)
      }. Persistence file: ${join(dataDir, "mastra.db")}`,
    );
  }

  const memory = new Memory({
    storage,
    options: {
      lastMessages: 40,
      observationalMemory: {
        enabled: true,
        model: memoryModel,
        observation: {
          messageTokens: 100_000,
        },
        reflection: {
          observationTokens: 200_000,
        },
      },
    },
  });

  const researchAgent = createResearchAgent(registry, projectDir, memory);
  const phasePlannerAgent = createPhasePlannerAgent(registry, projectDir, memory);
  const reviewAgent = createReviewAgent(registry, projectDir, memory);
  const designAgent = createDesignAgent(registry, projectDir, memory);
  const designLoopAgent = createDesignLoopAgent(registry, projectDir, memory);
  const planLoopAgent = createPlanLoopAgent(registry, projectDir, memory);
  const devSupervisorAgent = createDevSupervisorAgent(registry, projectDir, memory);
  const blueprintAgent = createBlueprintAgent(registry, projectDir, memory);
  const askAgent = createAskAgent(registry, projectDir, memory);
  const askSubResearchAgent = createAskSubResearchAgent(
    registry,
    projectDir,
    memory,
  );
  const agentChatAgent = createAgentChatAgent(registry, projectDir, memory);

  const agents = {
    researchAgent,
    phasePlannerAgent,
    reviewAgent,
    designAgent,
    designLoopAgent,
    planLoopAgent,
    devSupervisorAgent,
    blueprintAgent,
    askAgent,
    askSubResearchAgent,
    agentChatAgent,
  };

  const mastra = new Mastra({
    agents,
    storage,
  });

  const orchestrator = new ChangeOrchestrator({
    dataDir,
    registry,
    agents,
  });

  return {
    mastra,
    registry,
    memory,
    storage,
    orchestrator,
    agents,
  };
}

/**
 * Return a cached runtime for a project root. One Mastra/orchestrator instance
 * per project avoids recreating LibSQL + agents on every request.
 */
export function getSlopcontrolRuntime(
  dataDir: string,
  projectDir: string,
): SlopcontrolRuntime {
  const key = `${dataDir}::${projectDir}`;
  const existing = runtimeCache.get(key);
  if (existing) return existing;

  const runtime = createSlopcontrolMastra(dataDir, projectDir);
  runtimeCache.set(key, runtime);
  return runtime;
}

export function clearSlopcontrolRuntimeCache(): void {
  runtimeCache.clear();
}

export * from "./agents/index.js";
export * from "./orchestrator/index.js";
export * from "./tools/project-tools.js";
