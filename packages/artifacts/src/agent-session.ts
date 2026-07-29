import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@slopcontrol/types";

const SLOP_DIR = ".slopcontrol";

function slopRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR);
}

export function agentsRoot(projectRoot: string): string {
  return join(slopRoot(projectRoot), "agents");
}

export function agentDir(projectRoot: string, agentId: string): string {
  return join(agentsRoot(projectRoot), agentId);
}

export function ensureAgentDir(projectRoot: string, agentId: string): string {
  mkdirSync(slopRoot(projectRoot), { recursive: true });
  const dir = agentDir(projectRoot, agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function agentTranscriptPath(projectRoot: string, agentId: string): string {
  return join(agentDir(projectRoot, agentId), "TRANSCRIPT.md");
}

export function agentMetaPath(projectRoot: string, agentId: string): string {
  return join(agentDir(projectRoot, agentId), "meta.json");
}

export function formatAgentTranscript(agent: AgentSession): string {
  const lines = [
    `# Agent — ${agent.title?.trim() || agent.id}`,
    "",
    `- **id:** ${agent.id}`,
    `- **status:** ${agent.status}`,
    `- **updated:** ${agent.updatedAt}`,
    "",
    "## Transcript",
    "",
  ];
  for (const m of agent.messages) {
    const label = m.role === "user" ? "User" : "Assistant";
    lines.push(`### ${label} (${m.at})`, "", m.content.trim(), "");
  }
  return lines.join("\n");
}

/** Persist human-readable transcript + meta under `.slopcontrol/agents/<id>/`. */
export function writeAgentArtifacts(
  projectRoot: string,
  agent: AgentSession,
): { transcript: string; meta: string } {
  ensureAgentDir(projectRoot, agent.id);
  const transcript = agentTranscriptPath(projectRoot, agent.id);
  const meta = agentMetaPath(projectRoot, agent.id);
  writeFileSync(transcript, formatAgentTranscript(agent), "utf-8");
  writeFileSync(
    meta,
    JSON.stringify(
      {
        id: agent.id,
        projectId: agent.projectId,
        title: agent.title,
        status: agent.status,
        messageCount: agent.messages.length,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  return { transcript, meta };
}
