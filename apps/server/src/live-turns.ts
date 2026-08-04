/**
 * In-process live-turn registry for ask / agent / design / plan interactive turns.
 * Same process as SlopControl Express — not a remote Mastra server.
 */

import { randomUUID } from "node:crypto";

export type LiveTurnKind = "ask" | "agent" | "design_loop" | "plan_loop";

export type LiveTurnStatus =
  | "running"
  | "done"
  | "interrupted"
  | "failed";

/** Mirrors @slopcontrol/mastra LiveProgressEvent (kept local to avoid cycles). */
export type LiveTurnProgressEvent =
  | { type: "status"; summary: string }
  | { type: "tool_call"; tool: string; summary: string }
  | { type: "tool_result"; tool: string; summary: string }
  | { type: "text"; text: string };

export type LiveTurnEvent = LiveTurnProgressEvent & {
  at: string;
};

export type LiveTurnRecord = {
  turnId: string;
  kind: LiveTurnKind;
  projectId: string;
  sessionId: string;
  status: LiveTurnStatus;
  controller: AbortController;
  events: LiveTurnEvent[];
  startedAt: string;
  lastEventAt: string;
  interruptReason?: string;
  partialReply?: string;
};

type Listener = (event: LiveTurnEvent, turn: LiveTurnRecord) => void;

const MAX_EVENTS = 200;

export class LiveTurnRegistry {
  private readonly turns = new Map<string, LiveTurnRecord>();
  private readonly activeBySession = new Map<string, string>();
  private readonly listeners = new Set<Listener>();

  private sessionKey(kind: LiveTurnKind, sessionId: string): string {
    return `${kind}:${sessionId}`;
  }

  start(opts: {
    kind: LiveTurnKind;
    projectId: string;
    sessionId: string;
    turnId?: string;
  }): LiveTurnRecord {
    const sk = this.sessionKey(opts.kind, opts.sessionId);
    const priorId = this.activeBySession.get(sk);
    if (priorId) {
      const prior = this.turns.get(priorId);
      if (prior?.status === "running") {
        prior.controller.abort();
        prior.status = "interrupted";
        prior.interruptReason = "superseded";
      }
    }

    const turnId =
      opts.turnId ??
      `${opts.kind}:${opts.sessionId}:turn:${randomUUID()}`;
    const now = new Date().toISOString();
    const record: LiveTurnRecord = {
      turnId,
      kind: opts.kind,
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      status: "running",
      controller: new AbortController(),
      events: [],
      startedAt: now,
      lastEventAt: now,
    };
    this.turns.set(turnId, record);
    this.activeBySession.set(sk, turnId);
    return record;
  }

  get(turnId: string): LiveTurnRecord | undefined {
    return this.turns.get(turnId);
  }

  getActive(
    kind: LiveTurnKind,
    sessionId: string,
  ): LiveTurnRecord | undefined {
    const id = this.activeBySession.get(this.sessionKey(kind, sessionId));
    if (!id) return undefined;
    const t = this.turns.get(id);
    return t?.status === "running" ? t : undefined;
  }

  signal(turnId: string): AbortSignal | undefined {
    return this.turns.get(turnId)?.controller.signal;
  }

  emit(turnId: string, event: LiveTurnProgressEvent): void {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "running") return;
    const stamped: LiveTurnEvent = {
      ...event,
      at: new Date().toISOString(),
    };
    turn.events.push(stamped);
    if (turn.events.length > MAX_EVENTS) {
      turn.events.splice(0, turn.events.length - MAX_EVENTS);
    }
    turn.lastEventAt = stamped.at;
    for (const listener of this.listeners) {
      try {
        listener(stamped, turn);
      } catch {
        /* ignore */
      }
    }
  }

  complete(
    turnId: string,
    status: Exclude<LiveTurnStatus, "running">,
    opts?: { reason?: string; partialReply?: string },
  ): LiveTurnRecord | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    if (turn.status === "running") {
      turn.status = status;
      if (opts?.reason) turn.interruptReason = opts.reason;
      if (opts?.partialReply !== undefined) {
        turn.partialReply = opts.partialReply;
      }
    }
    const sk = this.sessionKey(turn.kind, turn.sessionId);
    if (this.activeBySession.get(sk) === turnId) {
      this.activeBySession.delete(sk);
    }
    return turn;
  }

  stop(
    kind: LiveTurnKind,
    sessionId: string,
    reason = "operator_stop",
  ): LiveTurnRecord | undefined {
    const turn = this.getActive(kind, sessionId);
    if (!turn) return undefined;
    turn.interruptReason = reason;
    turn.controller.abort();
    this.complete(turn.turnId, "interrupted", { reason });
    return turn;
  }

  stopByTurnId(
    turnId: string,
    reason = "operator_stop",
  ): LiveTurnRecord | undefined {
    const turn = this.turns.get(turnId);
    if (!turn || turn.status !== "running") return undefined;
    turn.interruptReason = reason;
    turn.controller.abort();
    return this.complete(turnId, "interrupted", { reason });
  }

  listActive(projectId?: string): LiveTurnRecord[] {
    return [...this.turns.values()].filter(
      (t) =>
        t.status === "running" &&
        (projectId == null || t.projectId === projectId),
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    for (const t of this.turns.values()) {
      if (t.status === "running") t.controller.abort();
    }
    this.turns.clear();
    this.activeBySession.clear();
  }
}

export const liveTurns = new LiveTurnRegistry();
