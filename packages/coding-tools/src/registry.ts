import type { CodingTool } from "./index.js";
import type { DesignTool } from "./design-tool.js";
import { OllamaImagesDesignTool } from "./design-tool.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";

const tools = new Map<string, CodingTool>([["opencode", new OpenCodeAdapter()]]);

const designTools = new Map<string, DesignTool>([
  ["ollama-images", new OllamaImagesDesignTool()],
]);

export function getCodingTool(id: string): CodingTool {
  const tool = tools.get(id);
  if (!tool) {
    throw new Error(`Unknown coding tool: ${id}`);
  }
  return tool;
}

export function registerCodingTool(tool: CodingTool): void {
  tools.set(tool.id, tool);
}

export function listCodingTools(): CodingTool[] {
  return [...tools.values()];
}

export function getDesignTool(id?: string): DesignTool {
  const key = id?.trim() || "ollama-images";
  const tool = designTools.get(key);
  if (!tool) {
    throw new Error(`Unknown design tool: ${key}`);
  }
  return tool;
}

export function registerDesignTool(tool: DesignTool): void {
  designTools.set(tool.id, tool);
}

export function listDesignTools(): DesignTool[] {
  return [...designTools.values()];
}
