import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allocatePhaseId, descriptionContentLine, ensurePhaseDir } from "@slopcontrol/artifacts";
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

/** Single-line title for asks (pasted errors often contain newlines). */
export function sanitizeAskTitle(
  raw: string | undefined,
  maxLen = 80,
): string | undefined {
  if (!raw) return undefined;
  const one = raw.replace(/\s+/g, " ").trim();
  if (!one) return undefined;
  return one.length <= maxLen ? one : one.slice(0, maxLen).trim();
}

/**
 * Single-line title for phases. Ask-derived descriptions start with a
 * "## Operator request" wrapper and may contain markdown/newlines; a raw
 * slice leaks all of that into the title (and on into the roadmap row).
 */
export function phaseTitleFromDescription(
  description: string | undefined,
  maxLen = 120,
): string {
  return descriptionContentLine(description).slice(0, maxLen);
}

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
    if (existing) {
      // Re-open with a new display name refreshes it (rename via open).
      const nextName = input.name.trim();
      if (nextName && nextName !== existing.name) {
        existing.name = nextName;
        existing.updatedAt = new Date().toISOString();
        this.save();
      }
      return existing;
    }

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
      title: phaseTitleFromDescription(input.description),
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
      .sort((a, b) => {
        const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
        if (byUpdated !== 0) return byUpdated;
        return b.createdAt.localeCompare(a.createdAt);
      });
  }

  /** Most recently created open ask for a project (sticky resume target). */
  latestOpenAsk(projectId: string): AskSession | undefined {
    return this.data.asks
      .filter((ask) => ask.projectId === projectId && ask.status === "open")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
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
    const fromMsg =
      input.firstMessage?.role === "user"
        ? sanitizeAskTitle(input.firstMessage.content)
        : undefined;
    const ask: AskSession = {
      id: randomUUID(),
      projectId: input.projectId,
      title: sanitizeAskTitle(input.title) || fromMsg,
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
      ask.title = sanitizeAskTitle(message.content);
    }
    this.updateAsk(ask);
    return ask;
  }

  /**
   * Replace the last assistant message (used for live "Working…" stub → final reply).
   * If the last message is not assistant, appends instead.
   */
  replaceLastAssistantAskMessage(
    askId: string,
    content: string,
    at?: string,
  ): AskSession | undefined {
    const ask = this.getAsk(askId);
    if (!ask) return undefined;
    const stamp = at ?? new Date().toISOString();
    const last = ask.messages[ask.messages.length - 1];
    if (last?.role === "assistant") {
      ask.messages = [
        ...ask.messages.slice(0, -1),
        { role: "assistant", content, at: stamp },
      ];
    } else {
      ask.messages = [
        ...ask.messages,
        { role: "assistant", content, at: stamp },
      ];
    }
    ask.updatedAt = stamp;
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

  /**
   * Clone an ask into a new open session so chat can continue after promote
   * without losing transcript context.
   */
  forkAsk(
    askId: string,
    opts?: { title?: string },
  ): AskSession | undefined {
    const source = this.getAsk(askId);
    if (!source) return undefined;
    const now = new Date().toISOString();
    const forked: AskSession = {
      id: randomUUID(),
      projectId: source.projectId,
      title:
        sanitizeAskTitle(opts?.title) ||
        sanitizeAskTitle(
          source.title ? `${source.title} (continued)` : undefined,
        ) ||
        sanitizeAskTitle("Continued ask"),
      status: "open",
      messages: source.messages.map((m) => ({ ...m })),
      createdAt: now,
      updatedAt: now,
    };
    this.data.asks.push(forked);
    this.save();
    return forked;
  }

  /** Mark project asks archived instead of deleting (reinit / phase-zero). */
  archiveProjectAsks(projectId: string): number {
    let n = 0;
    for (const ask of this.data.asks) {
      if (ask.projectId !== projectId) continue;
      if (ask.status === "archived") continue;
      ask.status = "archived" satisfies AskStatus;
      ask.updatedAt = new Date().toISOString();
      n += 1;
    }
    if (n > 0) this.save();
    return n;
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

  /** Remove phases/runs/agents; archive asks (keep history for list_asks / fork). */
  clearProjectWork(projectId: string): {
    phasesRemoved: number;
    runsRemoved: number;
    asksRemoved: number;
    asksArchived: number;
    agentsRemoved: number;
  } {
    const phasesBefore = this.data.phases.length;
    const runsBefore = this.data.runs.length;
    const agentsBefore = this.data.agents.length;
    this.data.phases = this.data.phases.filter((p) => p.projectId !== projectId);
    this.data.runs = this.data.runs.filter((r) => r.projectId !== projectId);
    this.data.agents = this.data.agents.filter((a) => a.projectId !== projectId);
    const asksArchived = this.archiveProjectAsks(projectId);
    this.save();
    return {
      phasesRemoved: phasesBefore - this.data.phases.length,
      runsRemoved: runsBefore - this.data.runs.length,
      asksRemoved: 0,
      asksArchived,
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
    // Full unregister: drop archived asks for this project too
    const asksBefore = this.data.asks.length;
    this.data.asks = this.data.asks.filter((a) => a.projectId !== projectId);
    const asksRemoved = asksBefore - this.data.asks.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== projectId);
    this.save();
    return {
      deleted: true,
      project,
      phasesRemoved: cleared.phasesRemoved,
      runsRemoved: cleared.runsRemoved,
      asksRemoved,
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
