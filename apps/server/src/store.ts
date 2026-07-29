import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allocatePhaseId, ensurePhaseDir } from "@slopcontrol/artifacts";
import type {
  AgentMessage,
  AgentSession,
  AskMessage,
  AskSession,
  AskStatus,
  Phase,
  Project,
  Run,
} from "@slopcontrol/types";

export interface SlopStoreData {
  projects: Project[];
  phases: Phase[];
  runs: Run[];
  asks: AskSession[];
  agents: AgentSession[];
}

export class SlopStore {
  private data: SlopStoreData;

  constructor(private readonly dbPath: string) {
    mkdirSync(join(this.dbPath, ".."), { recursive: true });
    this.data = this.load();
  }

  private load(): SlopStoreData {
    if (!existsSync(this.dbPath)) {
      return { projects: [], phases: [], runs: [], asks: [], agents: [] };
    }
    const raw = JSON.parse(readFileSync(this.dbPath, "utf-8")) as Partial<SlopStoreData>;
    return {
      projects: raw.projects ?? [],
      phases: raw.phases ?? [],
      runs: raw.runs ?? [],
      asks: raw.asks ?? [],
      agents: raw.agents ?? [],
    };
  }

  private save(): void {
    writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  listProjects(): Project[] {
    return this.data.projects;
  }

  getProject(id: string): Project | undefined {
    return this.data.projects.find((project) => project.id === id);
  }

  findProjectByRootPath(rootPath: string): Project | undefined {
    const normalized = rootPath.replace(/\/$/, "");
    return this.data.projects.find(
      (project) => project.rootPath.replace(/\/$/, "") === normalized,
    );
  }

  createProject(input: { name: string; rootPath: string }): Project {
    const existing = this.findProjectByRootPath(input.rootPath);
    if (existing) return existing;

    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      rootPath: input.rootPath,
      blueprintVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.projects.push(project);
    this.save();
    return project;
  }

  updateProject(project: Project): void {
    const index = this.data.projects.findIndex((item) => item.id === project.id);
    if (index >= 0) {
      this.data.projects[index] = project;
      this.save();
    }
  }

  listPhases(projectId: string): Phase[] {
    return this.data.phases
      .filter((phase) => phase.projectId === projectId)
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.createdAt.localeCompare(b.createdAt));
  }

  getPhase(id: string): Phase | undefined {
    return this.data.phases.find((phase) => phase.id === id);
  }

  createPhase(input: {
    projectId: string;
    description: string;
    rootPath: string;
    dependsOn?: string[];
  }): Phase {
    const now = new Date().toISOString();
    const allocated = allocatePhaseId(input.rootPath, input.description);
    ensurePhaseDir(input.rootPath, allocated.id);
    const dependsOn = [...new Set((input.dependsOn ?? []).filter(Boolean))];
    const phase: Phase = {
      id: allocated.id,
      projectId: input.projectId,
      description: input.description,
      status: "draft",
      ordinal: allocated.ordinal,
      slug: allocated.slug,
      title: input.description.slice(0, 120),
      dependsOn,
      createdAt: now,
      updatedAt: now,
    };
    this.data.phases.push(phase);
    this.save();
    return phase;
  }

  updatePhase(phase: Phase): void {
    const index = this.data.phases.findIndex((item) => item.id === phase.id);
    if (index >= 0) {
      this.data.phases[index] = phase;
      this.save();
    }
  }

  listRuns(projectId?: string): Run[] {
    const runs = projectId
      ? this.data.runs.filter((run) => run.projectId === projectId)
      : this.data.runs;
    return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string): Run | undefined {
    return this.data.runs.find((run) => run.id === id);
  }

  createRun(input: { phaseId: string; projectId: string }): Run {
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      phaseId: input.phaseId,
      projectId: input.projectId,
      stage: "idle",
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      stageTimings: [{ stage: "idle", startedAt: now }],
    };
    this.data.runs.push(run);
    this.save();
    return run;
  }

  updateRun(run: Run): void {
    const index = this.data.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) {
      this.data.runs[index] = run;
      this.save();
    }
  }

  deleteRun(id: string): void {
    this.data.runs = this.data.runs.filter((run) => run.id !== id);
    this.save();
  }

  listAsks(projectId: string): AskSession[] {
    return this.data.asks
      .filter((ask) => ask.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getAsk(id: string): AskSession | undefined {
    return this.data.asks.find((ask) => ask.id === id);
  }

  createAsk(input: {
    projectId: string;
    title?: string;
    firstMessage?: AskMessage;
  }): AskSession {
    const now = new Date().toISOString();
    const messages = input.firstMessage ? [input.firstMessage] : [];
    const ask: AskSession = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title?.trim() || undefined,
      status: "open",
      messages,
      createdAt: now,
      updatedAt: now,
    };
    this.data.asks.push(ask);
    this.save();
    return ask;
  }

  appendAskMessage(askId: string, message: AskMessage): AskSession | undefined {
    const ask = this.getAsk(askId);
    if (!ask) return undefined;
    ask.messages = [...ask.messages, message];
    ask.updatedAt = new Date().toISOString();
    if (!ask.title && message.role === "user") {
      ask.title = message.content.trim().slice(0, 80);
    }
    this.updateAsk(ask);
    return ask;
  }

  updateAsk(ask: AskSession): void {
    const index = this.data.asks.findIndex((item) => item.id === ask.id);
    if (index >= 0) {
      ask.updatedAt = new Date().toISOString();
      this.data.asks[index] = ask;
      this.save();
    }
  }

  markAskPromoted(askId: string, phaseId: string): AskSession | undefined {
    const ask = this.getAsk(askId);
    if (!ask) return undefined;
    ask.status = "promoted" satisfies AskStatus;
    ask.promotedPhaseId = phaseId;
    ask.updatedAt = new Date().toISOString();
    this.updateAsk(ask);
    return ask;
  }

  listAgents(projectId: string): AgentSession[] {
    return this.data.agents
      .filter((agent) => agent.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getAgent(id: string): AgentSession | undefined {
    return this.data.agents.find((agent) => agent.id === id);
  }

  createAgent(input: {
    projectId: string;
    title?: string;
    firstMessage?: AgentMessage;
  }): AgentSession {
    const now = new Date().toISOString();
    const messages = input.firstMessage ? [input.firstMessage] : [];
    const agent: AgentSession = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title?.trim() || undefined,
      status: "open",
      messages,
      createdAt: now,
      updatedAt: now,
    };
    this.data.agents.push(agent);
    this.save();
    return agent;
  }

  appendAgentMessage(
    agentId: string,
    message: AgentMessage,
  ): AgentSession | undefined {
    const agent = this.getAgent(agentId);
    if (!agent) return undefined;
    agent.messages = [...agent.messages, message];
    agent.updatedAt = new Date().toISOString();
    if (!agent.title && message.role === "user") {
      agent.title = message.content.trim().slice(0, 80);
    }
    this.updateAgent(agent);
    return agent;
  }

  updateAgent(agent: AgentSession): void {
    const index = this.data.agents.findIndex((item) => item.id === agent.id);
    if (index >= 0) {
      agent.updatedAt = new Date().toISOString();
      this.data.agents[index] = agent;
      this.save();
    }
  }

  /** Remove all phases, runs, asks, and agents for a project (phase-zero store reset). */
  clearProjectWork(projectId: string): {
    phasesRemoved: number;
    runsRemoved: number;
    asksRemoved: number;
    agentsRemoved: number;
  } {
    const phasesBefore = this.data.phases.length;
    const runsBefore = this.data.runs.length;
    const asksBefore = this.data.asks.length;
    const agentsBefore = this.data.agents.length;
    this.data.phases = this.data.phases.filter((p) => p.projectId !== projectId);
    this.data.runs = this.data.runs.filter((r) => r.projectId !== projectId);
    this.data.asks = this.data.asks.filter((a) => a.projectId !== projectId);
    this.data.agents = this.data.agents.filter((a) => a.projectId !== projectId);
    this.save();
    return {
      phasesRemoved: phasesBefore - this.data.phases.length,
      runsRemoved: runsBefore - this.data.runs.length,
      asksRemoved: asksBefore - this.data.asks.length,
      agentsRemoved: agentsBefore - this.data.agents.length,
    };
  }

  /**
   * Fully unregister a project: remove phases, runs, asks, agents, and the project row.
   * Does not touch files on disk (caller may purge .slopcontrol / worktrees).
   */
  deleteProject(projectId: string): {
    deleted: boolean;
    project?: Project;
    phasesRemoved: number;
    runsRemoved: number;
    asksRemoved: number;
    agentsRemoved: number;
  } {
    const project = this.getProject(projectId);
    if (!project) {
      return {
        deleted: false,
        phasesRemoved: 0,
        runsRemoved: 0,
        asksRemoved: 0,
        agentsRemoved: 0,
      };
    }
    const cleared = this.clearProjectWork(projectId);
    this.data.projects = this.data.projects.filter((p) => p.id !== projectId);
    this.save();
    return {
      deleted: true,
      project,
      phasesRemoved: cleared.phasesRemoved,
      runsRemoved: cleared.runsRemoved,
      asksRemoved: cleared.asksRemoved,
      agentsRemoved: cleared.agentsRemoved,
    };
  }
}

export function defaultDataDir(): string {
  const configured = process.env.SLOPCONTROL_DATA_DIR?.trim();
  return configured && configured.length > 0
    ? configured
    : join(homedir(), ".slopcontrol");
}

export function createStore(): SlopStore {
  const dataDir = defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  return new SlopStore(join(dataDir, "store.json"));
}
