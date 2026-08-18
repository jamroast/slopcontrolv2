import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import {
  classifyAskResumeViaLlm,
  classifyChatConfirmViaLlm,
  LlmRegistry,
  loadProvidersConfig,
  type AskResumeClassification,
  type ChatConfirmClassification,
  type ParkedChatAction,
} from "@slopcontrol/llm";
import { buildChatTaskDescription } from "@slopcontrol/artifacts";
import {
  isGateRunStage,
  isTerminalRunStage,
  type AgentRole,
  type ChatConversation,
} from "@slopcontrol/types";
import {
  ASK_SYNTHESIS_PROMPT_PREFIX,
  askProgressFromStreamChunk,
  decideNarrationSynthesis,
} from "../orchestrator/ask-stream.js";
import { recallProjectKnowledge } from "../orchestrator/project-knowledge.js";
import { isPromptTooLongError } from "../supervisor-enrich.js";
import {
  buildChatTools,
  formatChatDispatchResult,
  listChatToolNames,
} from "./chat-tools.js";
import {
  buildGlobalChatPrompt,
  buildProjectChatPrompt,
} from "./lifecycle-context.js";
import {
  bindFunctionToModel,
  buildFunctionMappingList,
  buildProviderCatalogs,
  listUniqueProviderModels,
  providersPathFromEndpoints,
  resolveConversationModelOverride,
  updateEndpointModel,
  type BindFunctionResult,
  type EndpointModelList,
  type FunctionMappingList,
} from "./models.js";
import {
  advanceRun,
  formatAdvanceRunResult,
  runIdFromLifecycle,
  shouldAdvanceAfterConfirm,
  stageFromDispatchText,
} from "./advance-run.js";
import {
  buildRunSettledNotification,
  formatRunNotificationBrief,
  type RunSettledContext,
} from "./run-settled-notification.js";
import { createToolCallGuard } from "./tool-call-guard.js";
import type { RunStageUpdate } from "../run-stage-broker.js";
import {
  DEFAULT_FOLLOW_UP_WAIT_MS,
  DEFAULT_WAIT_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  LIFECYCLE_WAIT_TOOLS,
  extractBusyRunFromLifecycleResult,
  formatWaitForRunResult,
  isBusyRunStage,
  resolveWaitConfig,
  runWaitKindForStage,
  runWaitKindForTool,
  waitForRun,
  type RunWaitKind,
  type WaitConfigOverrides,
} from "./wait-run.js";
import {
  applyAskResumeDecision,
  ASK_ID_DEPENDENT_TOOLS,
  composeAskDispatchMessage,
  decideAskResume,
  isAskOpen,
  parseAskIdFromDispatch,
  parseAskStatusFromDispatch,
  type AskResumeLatch,
} from "./ask-routing.js";
import {
  hasPlanAcceptanceTicks,
  parseLoopIdFromDispatch,
  parsePlanLoopStatusFromDispatch,
  PLAN_LOOP_ID_DEPENDENT_TOOLS,
  type PlanResumeLatch,
} from "./plan-routing.js";
import type {
  AwaitedLiveTurn,
  AwaitedRun,
  ChatContextDeps,
  ChatEvent,
  ChatEventListener,
  ChatToolDispatch,
  ChatToolResult,
  ChatTranscriptMessage,
  ConversationStore,
  PendingAction,
} from "./types.js";
import {
  backfillLoopStartBrief,
  LIVE_TURN_ASYNC_TOOLS,
  liveTurnKindForTool,
  liveTurnStartedMessage,
  sessionIdFromLiveTurnArgs,
  type LiveTurnProgressEvent,
} from "./live-turn-chat.js";

const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_TURN_TIMEOUT_MS = 720_000;
const MAX_STEPS = 16;
const SYSTEM_TURN_MAX_STEPS = 1;

export interface ChatServiceDeps {
  store: ConversationStore;
  /** Lazy — the Memory instance comes from a Mastra runtime created on demand. */
  getMemory: () => Memory;
  dispatch: ChatToolDispatch;
  context: ChatContextDeps;
  /** Path to endpoints.json — re-read per turn so model edits apply live. */
  endpointsPath: string;
  /** Called after endpoints.json is rewritten so cached runtimes pick up the new default. */
  onEndpointsChanged?: () => void;
  /**
   * Classify an operator message against parked gated actions.
   * Injected so tests stub the LLM. Production default uses the
   * classification role (fail-closed to unrelated).
   */
  classifyConfirm?: (opts: {
    message: string;
    parked: ParkedChatAction[];
  }) => Promise<ChatConfirmClassification>;
  /**
   * continue vs new for a latched ask. Injected so tests stub the LLM.
   * Throw / omit → fail-closed to new.
   */
  classifyAskResume?: (opts: {
    message: string;
    latchTitle?: string;
    latchLastUser?: string;
  }) => Promise<AskResumeClassification>;
  confirmTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** How long confirm/auto-wait blocks for a busy run (default 90s). */
  waitTimeoutMs?: number;
  waitPollMs?: number;
  /** Background follow-up wait after inline wait times out (0 disables). */
  followUpWaitMs?: number;
  /** Progress-event cadence for watchers (test-only override). */
  waitProgressIntervalMs?: number;
  /** Subscribe to run stage transitions (server touchRunStage pub/sub). */
  subscribeRunUpdates?: (
    runId: string,
    listener: (update: RunStageUpdate) => void,
  ) => () => void;
  /** Subscribe to interactive live-turn progress (plan/design/ask/agent). */
  subscribeLiveTurnUpdates?: (
    listener: (
      event: LiveTurnProgressEvent,
      turn: {
        turnId: string;
        kind: AwaitedLiveTurn["kind"];
        sessionId: string;
        projectId: string;
        status: string;
      },
    ) => void,
  ) => () => void;
}

export class ConversationClosedError extends Error {
  readonly code = "conversation_closed" as const;
  constructor(id: string) {
    super(`Conversation ${id} is closed`);
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = "conversation_not_found" as const;
  constructor(id: string) {
    super(`Conversation ${id} not found`);
  }
}

/**
 * Per-project + global chat agent service. Conversations persist as Mastra
 * Memory threads (mastra.db); metadata lives in the SlopStore conversations
 * collection. All events fan out to subscribers (per-chat SSE, project and
 * global aggregate streams).
 */
export class ChatService {
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<string, PendingAction>();
  private readonly confirmTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly waitTimeoutMs: number;
  private readonly waitPollMs: number;
  private readonly followUpWaitMs: number;
  /**
   * Raw deps overrides for the per-kind WAIT_CONFIG. When present they win
   * over the per-kind defaults — tests inject millisecond waits and
   * followUpWaitMs: 0 disables follow-ups entirely.
   */
  private readonly waitOverrides: WaitConfigOverrides;
  private readonly runWatchers = new Map<string, AbortController>();
  private readonly busyConversations = new Set<string>();
  /** Operator said proceed — keep reconciling until busy-or-human-stop. */
  private readonly proceedLatches = new Map<
    string,
    { conversationId: string; runId: string; projectId?: string }
  >();
  /** Last ask this conversation started or continued — not project latestOpenAsk. */
  private readonly askLatches = new Map<string, AskResumeLatch>();
  /** Last plan loop this conversation started or continued. */
  private readonly planLatches = new Map<string, PlanResumeLatch>();
  /** Operator utterance for the in-flight sendMessage (ask routing). */
  private turnOperatorMessage = "";
  /**
   * Runs this conversation is actively awaiting (in-memory, backed by
   * store.setAwaitedRun for restart recovery). Keyed by conversationId.
   */
  private readonly awaitedRuns = new Map<string, AwaitedRun>();
  /**
   * Per-conversation notification queue. Background watchers push here
   * instead of spin-waiting on busyConversations. Drained after each turn.
   */
  private readonly notificationQueue = new Map<string, string[]>();
  /** Dedupe settlement delivery when event + poll paths race. */
  private readonly deliveredRunNotifications = new Map<string, Set<string>>();
  /** Live turns (plan/design loops) this chat awaits — event-driven, no polling. */
  private readonly awaitedLiveTurns = new Map<string, AwaitedLiveTurn>();
  private readonly deliveredLiveNotifications = new Map<string, Set<string>>();
  private readonly unsubscribeLiveTurns?: () => void;

  constructor(private readonly deps: ChatServiceDeps) {
    this.emitter.setMaxListeners(100);
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.waitPollMs = deps.waitPollMs ?? DEFAULT_WAIT_INTERVAL_MS;
    this.followUpWaitMs = deps.followUpWaitMs ?? DEFAULT_FOLLOW_UP_WAIT_MS;
    this.waitOverrides = {
      inlineMs: deps.waitTimeoutMs,
      followUpMs: deps.followUpWaitMs,
      progressIntervalMs: deps.waitProgressIntervalMs,
    };
    if (deps.subscribeLiveTurnUpdates) {
      this.unsubscribeLiveTurns = deps.subscribeLiveTurnUpdates((event, turn) => {
        this.handleLiveTurnProgress(event, turn);
      });
    }
  }

  /** Effective wait windows for a run kind: instance overrides beat WAIT_CONFIG. */
  private waitConfigFor(kind: RunWaitKind): {
    inlineMs: number;
    followUpMs: number;
    progressIntervalMs: number;
  } {
    return resolveWaitConfig(kind, this.waitOverrides);
  }

  // ---- events ----

  subscribe(listener: ChatEventListener): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  private emit(
    conversation: Pick<ChatConversation, "id" | "projectId">,
    event: Omit<ChatEvent, "conversationId" | "projectId" | "at">,
  ): void {
    const full: ChatEvent = {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      at: new Date().toISOString(),
      ...event,
    };
    this.emitter.emit("event", full);
  }

  // ---- CRUD ----

  createConversation(input: {
    projectId: string | null;
    title?: string;
    modelOverride?: ChatConversation["modelOverride"];
  }): ChatConversation {
    if (input.projectId && !this.deps.context.getProject(input.projectId)) {
      throw new ConversationNotFoundError(`project ${input.projectId}`);
    }
    return this.deps.store.createConversation(input);
  }

  listConversations(opts?: {
    projectId?: string | null;
    status?: ChatConversation["status"];
  }): ChatConversation[] {
    return this.deps.store.listConversations(opts);
  }

  /** List plus Memory-backed messageCount for operator-facing chat lists. */
  async listConversationsDetailed(opts?: {
    projectId?: string | null;
    status?: ChatConversation["status"];
  }): Promise<Array<ChatConversation & { messageCount: number }>> {
    const rows = this.listConversations(opts);
    return Promise.all(
      rows.map(async (conversation) => {
        try {
          const messages = await this.getMessages(conversation.id);
          return { ...conversation, messageCount: messages.length };
        } catch {
          return { ...conversation, messageCount: 0 };
        }
      }),
    );
  }

  getConversation(id: string): ChatConversation {
    const conversation = this.deps.store.getConversation(id);
    if (!conversation) throw new ConversationNotFoundError(id);
    return conversation;
  }

  closeConversation(id: string): ChatConversation {
    const conversation = this.getConversation(id);
    this.clearProceedLatchesForConversation(id);
    this.askLatches.delete(id);
    this.planLatches.delete(id);
    this.awaitedRuns.delete(id);
    this.awaitedLiveTurns.delete(id);
    this.deliveredLiveNotifications.delete(id);
    this.notificationQueue.delete(id);
    this.deps.store.setAwaitedRun?.(id, null);
    this.deps.store.setAwaitedLiveTurn?.(id, null);
    const closed = this.deps.store.closeConversation(id) ?? conversation;
    this.emit(closed, { type: "closed" });
    return closed;
  }

  /** Re-open a closed conversation so the operator can continue the thread. */
  reopenConversation(id: string): ChatConversation {
    const conversation = this.getConversation(id);
    if (conversation.status === "active") return conversation;
    conversation.status = "active";
    conversation.closedAt = undefined;
    conversation.lastActiveAt = new Date().toISOString();
    this.deps.store.updateConversation(conversation);
    this.emit(conversation, { type: "status", summary: "reopened" });
    return conversation;
  }

  deleteConversation(id: string): boolean {
    const conversation = this.deps.store.getConversation(id);
    if (!conversation) return false;
    this.clearProceedLatchesForConversation(id);
    this.askLatches.delete(id);
    this.planLatches.delete(id);
    this.awaitedRuns.delete(id);
    this.awaitedLiveTurns.delete(id);
    this.deliveredRunNotifications.delete(id);
    this.deliveredLiveNotifications.delete(id);
    this.notificationQueue.delete(id);
    void this.deps
      .getMemory()
      .deleteThread(conversation.id)
      .catch(() => {
        /* thread may not exist yet */
      });
    return this.deps.store.deleteConversation(id);
  }

  /**
   * Replay the Memory thread as a user/assistant transcript. Tool-call
   * parts and observational-memory status blobs are omitted — those are
   * agent internals, not operator-facing chat.
   */
  async getMessages(id: string): Promise<ChatTranscriptMessage[]> {
    const conversation = this.getConversation(id);
    const recalled = await this.deps.getMemory().recall({
      threadId: conversation.id,
      resourceId: conversation.projectId ?? "global",
      perPage: false,
    });
    return (recalled.messages ?? [])
      .map((row) => toTranscriptMessage(row))
      .filter((m): m is ChatTranscriptMessage => m !== null);
  }

  /**
   * Idle sweep: close active conversations past maxIdleMs. Returns closed.
   * A conversation awaiting a run is exempt only while that run still
   * exists and is busy — a deleted or settled run must not pin the
   * conversation (and its in-memory wait state) open forever.
   */
  closeIdleConversations(maxIdleMs: number, now: Date = new Date()): string[] {
    const closed: string[] = [];
    for (const c of this.deps.store.listConversations({ status: "active" })) {
      const idleMs = now.getTime() - Date.parse(c.lastActiveAt);
      if (idleMs < maxIdleMs) continue;
      const awaited = c.awaitedRun ?? this.awaitedRuns.get(c.id);
      if (awaited) {
        const run = this.lookupRun(awaited.runId);
        if (run && isBusyRunStage(run.stage)) continue;
        // Stale wait — run gone or settled without a notification reaching
        // this conversation. Drop it and let the idle rule apply.
        this.awaitedRuns.delete(c.id);
        this.deps.store.setAwaitedRun?.(c.id, null);
      }
      this.clearProceedLatchesForConversation(c.id);
      this.askLatches.delete(c.id);
      this.planLatches.delete(c.id);
      this.awaitedRuns.delete(c.id);
      this.awaitedLiveTurns.delete(c.id);
      this.deliveredLiveNotifications.delete(c.id);
      this.notificationQueue.delete(c.id);
      this.deps.store.setAwaitedRun?.(c.id, null);
      this.deps.store.setAwaitedLiveTurn?.(c.id, null);
      this.deps.store.closeConversation(c.id);
      this.emit(c, { type: "closed", summary: "idle timeout" });
      closed.push(c.id);
    }
    return closed;
  }

  /** Bump idle-close clock without changing title (run activity counts as active). */
  private bumpConversationActivity(conversationId: string): void {
    this.deps.store.touchConversation(conversationId);
  }

  private runSettledContext(): RunSettledContext {
    return { getProject: (id) => this.deps.context.getProject(id) };
  }

  /**
   * Called when a run leaves a busy stage (gate or terminal). Delivers
   * notifications to every conversation awaiting this run.
   */
  async handleRunStageChanged(run: {
    id: string;
    stage: string;
    phaseId?: string;
    projectId?: string;
  }): Promise<void> {
    if (isBusyRunStage(run.stage)) return;

    const latched = this.conversationsAwaitingRun(run.id);
    for (const { conversationId } of latched) {
      const watchKey = `${conversationId}:${run.id}`;
      this.runWatchers.get(watchKey)?.abort();
      this.runWatchers.delete(watchKey);

      const conversation = this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.status === "closed") {
        this.clearProceedLatch(conversationId, run.id);
        this.awaitedRuns.delete(conversationId);
        this.deps.store.setAwaitedRun?.(conversationId, null);
        continue;
      }

      try {
        await this.completeAwaitedRunForConversation(conversation, run.id, {
          stage: run.stage,
          phaseId: run.phaseId,
          projectId: run.projectId,
          elapsedMs: this.elapsedMsForAwaited(conversationId, run.id),
        });
      } catch (err) {
        /* best-effort — watcher poll fallback may still deliver */
        void err;
      }
    }
  }

  /** @deprecated alias — use handleRunStageChanged */
  handleRunSettled(run: {
    id: string;
    stage: string;
    phaseId?: string;
    projectId?: string;
  }): void {
    void this.handleRunStageChanged(run);
  }

  private conversationsAwaitingRun(
    runId: string,
  ): Array<{ conversationId: string; runId: string }> {
    const latched: Array<{ conversationId: string; runId: string }> = [];
    for (const [, latch] of this.proceedLatches) {
      if (latch.runId === runId) {
        latched.push({ conversationId: latch.conversationId, runId: latch.runId });
      }
    }
    for (const [conversationId, awaited] of this.awaitedRuns) {
      if (
        awaited.runId === runId &&
        !latched.some((l) => l.conversationId === conversationId)
      ) {
        latched.push({ conversationId, runId });
      }
    }
    for (const c of this.deps.store.listConversations({ status: "active" })) {
      const awaited = c.awaitedRun;
      if (!awaited || awaited.runId !== runId) continue;
      if (latched.some((l) => l.conversationId === c.id)) continue;
      this.awaitedRuns.set(c.id, awaited);
      latched.push({ conversationId: c.id, runId });
    }
    return latched;
  }

  /** Track that this conversation should receive run-stage push notifications. */
  private registerAwaitedRun(
    conversation: ChatConversation,
    runId: string,
    kind: RunWaitKind,
  ): void {
    const existing = this.awaitedRuns.get(conversation.id);
    const projectId =
      conversation.projectId ??
      this.lookupRun(runId)?.projectId ??
      existing?.projectId ??
      runId;
    const awaited: AwaitedRun = {
      runId,
      projectId,
      kind,
      startedAt:
        existing?.runId === runId
          ? existing.startedAt
          : new Date().toISOString(),
    };
    this.awaitedRuns.set(conversation.id, awaited);
    this.deps.store.setAwaitedRun?.(conversation.id, awaited);
    this.bumpConversationActivity(conversation.id);
    const liveStage = this.lookupRun(runId)?.stage;
    this.emit(conversation, {
      type: "run_awaited",
      summary: `waiting for ${kind} run ${runId}…`,
      run: {
        runId,
        projectId,
        stage: liveStage,
        kind,
      },
    });
  }

  private registerAwaitedLiveTurn(
    conversation: ChatConversation,
    tool: string,
    args: Record<string, unknown>,
  ): void {
    const kind = liveTurnKindForTool(tool);
    if (!kind) return;
    const projectId =
      conversation.projectId ??
      (typeof args.projectId === "string" ? args.projectId.trim() : "");
    if (!projectId) return;
    const sessionId = sessionIdFromLiveTurnArgs(tool, args);
    const awaited: AwaitedLiveTurn = {
      kind,
      projectId,
      sessionId,
      turnId: undefined,
      startedAt: new Date().toISOString(),
    };
    this.awaitedLiveTurns.set(conversation.id, awaited);
    this.deps.store.setAwaitedLiveTurn?.(conversation.id, awaited);
    this.bumpConversationActivity(conversation.id);
    this.emit(conversation, {
      type: "live_awaited",
      summary: `waiting for ${kind} turn…`,
      live: {
        kind,
        projectId,
        sessionId,
        status: "running",
      },
    });
  }

  hasActiveLiveTurn(conversationId: string, loopId?: string): boolean {
    const awaited = this.awaitedLiveTurns.get(conversationId);
    if (!awaited) return false;
    if (loopId && awaited.sessionId && awaited.sessionId !== loopId) {
      return false;
    }
    return true;
  }

  private conversationsAwaitingLiveTurn(turn: {
    turnId: string;
    kind: AwaitedLiveTurn["kind"];
    sessionId: string;
    projectId: string;
  }): string[] {
    const matched = new Set<string>();
    // Sessions already claimed by any conversation — an unbound await must
    // not steal progress for a turn another chat is bound to.
    const boundSessions = new Set(
      [...this.awaitedLiveTurns.values()]
        .map((a) => a.sessionId)
        .filter((s): s is string => Boolean(s)),
    );
    const fits = (awaited: AwaitedLiveTurn, conversationId: string) => {
      if (awaited.kind !== turn.kind) return;
      if (awaited.projectId !== turn.projectId) return;
      if (awaited.turnId && awaited.turnId !== turn.turnId) return;
      if (
        awaited.sessionId &&
        turn.sessionId &&
        awaited.sessionId !== turn.sessionId
      ) {
        return;
      }
      if (
        !awaited.sessionId &&
        turn.sessionId &&
        boundSessions.has(turn.sessionId)
      ) {
        return;
      }
      matched.add(conversationId);
    };
    for (const [conversationId, awaited] of this.awaitedLiveTurns) {
      fits(awaited, conversationId);
    }
    for (const c of this.deps.store.listConversations({ status: "active" })) {
      const persisted = c.awaitedLiveTurn;
      if (!persisted) continue;
      this.awaitedLiveTurns.set(c.id, persisted);
      fits(persisted, c.id);
    }
    return [...matched];
  }

  private handleLiveTurnProgress(
    event: LiveTurnProgressEvent,
    turn: {
      turnId: string;
      kind: AwaitedLiveTurn["kind"];
      sessionId: string;
      projectId: string;
      status: string;
    },
  ): void {
    if (turn.status !== "running") return;
    const summary =
      event.type === "status"
        ? String(event.summary ?? "").trim()
        : event.type === "tool_call" || event.type === "tool_result"
          ? `${event.type}: ${event.tool ?? ""} ${event.summary ?? ""}`.trim()
          : "";
    if (!summary || summary === "step") return;

    for (const conversationId of this.conversationsAwaitingLiveTurn(turn)) {
      const conversation = this.getConversation(conversationId);
      const awaited = this.awaitedLiveTurns.get(conversationId);
      if (!awaited) continue;
      const next: AwaitedLiveTurn = {
        ...awaited,
        turnId: turn.turnId,
        sessionId: awaited.sessionId || turn.sessionId || undefined,
      };
      this.awaitedLiveTurns.set(conversationId, next);
      this.deps.store.setAwaitedLiveTurn?.(conversationId, next);
      this.emit(conversation, {
        type: "live_progress",
        summary: summary.slice(0, 240),
        live: {
          turnId: turn.turnId,
          kind: turn.kind,
          sessionId: turn.sessionId,
          projectId: turn.projectId,
          status: turn.status,
        },
      });
    }
  }

  private async completeAwaitedLiveTurnForConversation(
    conversation: ChatConversation,
    tool: string,
    resultText: string,
    isError: boolean,
  ): Promise<void> {
    const awaited = this.awaitedLiveTurns.get(conversation.id);
    if (!awaited) return;
    // Per-turn key: turnId once bound; startedAt nonce before that so two
    // consecutive same-shape starts don't collide on "start".
    const dedupeKey = awaited.turnId
      ? `${awaited.turnId}:${isError ? "err" : "ok"}`
      : `${awaited.kind}:${awaited.sessionId ?? "start"}:${awaited.startedAt}:${isError ? "err" : "ok"}`;
    const seen =
      this.deliveredLiveNotifications.get(conversation.id) ??
      new Set<string>();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    this.deliveredLiveNotifications.set(conversation.id, seen);

    this.awaitedLiveTurns.delete(conversation.id);
    this.deps.store.setAwaitedLiveTurn?.(conversation.id, null);

    const elapsedMs = Date.now() - Date.parse(awaited.startedAt);
    this.emit(conversation, {
      type: "live_settled",
      summary: isError ? `${tool} failed` : `${tool} complete`,
      text: resultText.slice(0, 500),
      live: {
        turnId: awaited.turnId,
        kind: awaited.kind,
        sessionId: awaited.sessionId,
        projectId: awaited.projectId,
        status: isError ? "failed" : "done",
        elapsedMs,
        isError,
      },
    });

    const notify = isError
      ? `[live turn ${tool} FAILED]\n${resultText.slice(0, 3_000)}`
      : `[live turn ${tool} settled]\n${resultText.slice(0, 3_000)}`;
    const existing = this.notificationQueue.get(conversation.id) ?? [];
    existing.push(notify);
    this.notificationQueue.set(conversation.id, existing);
    if (!this.busyConversations.has(conversation.id)) {
      this.drainNotificationQueue(conversation.id);
    }
  }

  private runAsyncLiveTurnDispatch(
    conversation: ChatConversation,
    tool: string,
    args: Record<string, unknown>,
  ): void {
    void (async () => {
      try {
        const result = await this.dispatchRouted(conversation, tool, args);
        const text = formatChatDispatchResult(result, tool);
        // Single settlement write: the notification drained in
        // completeAwaitedLiveTurnForConversation is the Memory record — no
        // follow-up synthetic turn, or the thread gets the result twice.
        await this.completeAwaitedLiveTurnForConversation(
          conversation,
          tool,
          text,
          Boolean(result.isError),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.completeAwaitedLiveTurnForConversation(
          conversation,
          tool,
          msg,
          true,
        );
      }
    })();
  }

  /**
   * Startup recovery: a persisted awaitedLiveTurn is always orphaned — the
   * async dispatch and the server-side liveTurns registry are in-process, so
   * the turn died with the old process. Clear it and tell the operator to
   * re-issue the command (otherwise the chat waits forever and the
   * tool-call guard keeps plan_loop_get / design_loop_get disabled).
   */
  recoverAwaitedLiveTurns(): void {
    for (const c of this.deps.store.listConversations({ status: "active" })) {
      const awaited = c.awaitedLiveTurn;
      if (!awaited) continue;
      this.deps.store.setAwaitedLiveTurn?.(c.id, null);
      const existing = this.notificationQueue.get(c.id) ?? [];
      existing.push(
        `[live turn interrupted] The ${awaited.kind} turn was cut off by a server restart — re-issue the plan/design command.`,
      );
      this.notificationQueue.set(c.id, existing);
      if (!this.busyConversations.has(c.id)) {
        this.drainNotificationQueue(c.id);
      }
    }
  }

  private trackLifecycleRunBeforeDispatch(
    conversation: ChatConversation,
    tool: string,
    args: Record<string, unknown>,
  ): void {
    if (!LIFECYCLE_WAIT_TOOLS.has(tool)) return;
    const runId = runIdFromLifecycle(args, "");
    if (!runId) return;
    const kind =
      runWaitKindForTool(tool) ??
      runWaitKindForStage(this.lookupRun(runId)?.stage);
    this.registerAwaitedRun(conversation, runId, kind);
  }

  private trackLifecycleRunFromResult(
    conversation: ChatConversation,
    tool: string,
    resultText: string,
  ): void {
    if (!LIFECYCLE_WAIT_TOOLS.has(tool)) return;
    if (this.awaitedRuns.has(conversation.id)) return;
    const extracted = extractBusyRunFromLifecycleResult(resultText);
    if (!extracted?.runId || !isBusyRunStage(extracted.stage)) return;
    const kind =
      runWaitKindForTool(tool) ?? runWaitKindForStage(extracted.stage);
    this.registerAwaitedRun(conversation, extracted.runId, kind);
  }

  private elapsedMsForAwaited(conversationId: string, runId: string): number {
    const awaited = this.awaitedRuns.get(conversationId);
    if (awaited?.runId === runId) {
      return Date.now() - Date.parse(awaited.startedAt);
    }
    return 0;
  }

  /**
   * Shared settlement path for event-driven notifications and poll fallback.
   * Returns true when the follow-up watcher should reschedule (proceed latch).
   */
  private async completeAwaitedRunForConversation(
    conversation: ChatConversation,
    runId: string,
    outcome: {
      stage: string;
      phaseId?: string;
      projectId?: string;
      elapsedMs?: number;
    },
    kind: RunWaitKind = this.awaitedRuns.get(conversation.id)?.kind ??
      runWaitKindForStage(outcome.stage),
  ): Promise<boolean> {
    const dedupeKey = `${runId}:${outcome.stage}`;
    const seen =
      this.deliveredRunNotifications.get(conversation.id) ?? new Set<string>();
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    this.deliveredRunNotifications.set(conversation.id, seen);

    this.awaitedRuns.delete(conversation.id);
    this.deps.store.setAwaitedRun?.(conversation.id, null);

    this.emit(conversation, {
      type: "run_settled",
      summary: `run reached ${outcome.stage}`,
      run: {
        runId,
        projectId: outcome.projectId,
        stage: outcome.stage,
        kind,
        elapsedMs: outcome.elapsedMs,
      },
    });

    if (isTerminalRunStage(outcome.stage)) {
      this.clearProceedLatch(conversation.id, runId);
    }

    const config = this.waitConfigFor(kind);
    const latch = this.proceedLatches.get(
      this.proceedLatchKey(conversation.id, runId),
    );
    let extra = "";
    let advanceError: string | undefined;
    let reschedule = false;

    if (latch && isGateRunStage(outcome.stage)) {
      const advanced = await this.maybeAdvanceRun(
        conversation,
        "advance_run",
        {
          runId,
          ...(latch.projectId ? { projectId: latch.projectId } : {}),
        },
        JSON.stringify({ runId, stage: outcome.stage }),
        { skipFollowUpWait: true },
      );
      extra = `\n\n${advanced.text}`;
      if (advanced.kind === "error") {
        advanceError = advanced.text.slice(0, 500);
      }
      const live = this.lookupRun(runId);
      if (isTerminalRunStage(live?.stage) || isTerminalRunStage(advanced.stage)) {
        this.clearProceedLatch(conversation.id, runId);
      } else if (
        live &&
        isBusyRunStage(live.stage) &&
        config.followUpMs > 0
      ) {
        reschedule = true;
      }
    }

    const note = [
      buildRunSettledNotification(
        {
          id: runId,
          stage: outcome.stage,
          phaseId: outcome.phaseId,
          projectId: outcome.projectId,
        },
        this.runSettledContext(),
      ),
      extra.trim(),
      advanceError
        ? `Advance error: ${advanceError}. Use get_run for details.`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    const existing = this.notificationQueue.get(conversation.id) ?? [];
    existing.push(note);
    this.notificationQueue.set(conversation.id, existing);

    if (!this.busyConversations.has(conversation.id)) {
      this.drainNotificationQueue(conversation.id);
    }

    return reschedule;
  }

  /**
   * Append a system notification to Memory and SSE without invoking the LLM.
   */
  private async deliverSystemNotification(
    conversation: ChatConversation,
    userNote: string,
    assistantBrief: string,
  ): Promise<void> {
    this.bumpConversationActivity(conversation.id);
    const resourceId = conversation.projectId ?? "global";
    const threadId = conversation.id;
    const now = new Date();
    const mkMessage = (
      role: "user" | "assistant",
      text: string,
    ): {
      id: string;
      role: "user" | "assistant";
      createdAt: Date;
      threadId: string;
      resourceId: string;
      content: {
        format: 2;
        parts: Array<{ type: "text"; text: string }>;
      };
    } => ({
      id: randomUUID(),
      role,
      createdAt: now,
      threadId,
      resourceId,
      content: {
        format: 2,
        parts: [{ type: "text", text }],
      },
    });

    await this.deps.getMemory().saveMessages({
      messages: [
        mkMessage("user", userNote),
        mkMessage("assistant", assistantBrief),
      ],
    });

    this.emit(conversation, {
      type: "status",
      summary: "run notification recorded",
    });
    this.emit(conversation, { type: "delta", text: assistantBrief });
    this.emit(conversation, { type: "done", text: assistantBrief });
  }

  /**
   * Return the run this conversation is currently awaiting (if any).
   * Enriched with live stage/elapsed for dashboard display.
   */
  getAwaitedRun(conversationId: string): (AwaitedRun & { stage?: string; elapsedMs?: number }) | null {
    const awaited = this.awaitedRuns.get(conversationId);
    if (!awaited) return null;
    const run = this.lookupRun(awaited.runId);
    return {
      ...awaited,
      stage: run?.stage,
      elapsedMs: Date.now() - new Date(awaited.startedAt).getTime(),
    };
  }

  /**
   * List all active conversations that are currently awaiting a run,
   * enriched with live stage/elapsed for dashboard overview.
   */
  listAwaitedRuns(): Array<AwaitedRun & { conversationId: string; stage?: string; elapsedMs?: number }> {
    const results: Array<AwaitedRun & { conversationId: string; stage?: string; elapsedMs?: number }> = [];
    for (const [conversationId, awaited] of this.awaitedRuns) {
      const conversation = this.deps.store.getConversation(conversationId);
      if (!conversation || conversation.status === "closed") continue;
      const run = this.lookupRun(awaited.runId);
      results.push({
        ...awaited,
        conversationId,
        stage: run?.stage,
        elapsedMs: Date.now() - new Date(awaited.startedAt).getTime(),
      });
    }
    return results;
  }

  /**
   * Startup recovery: re-establish watchers for any active conversation
   * that has a persisted awaitedRun whose run is still busy.
   */
  recoverAwaitedRuns(): void {
    for (const c of this.deps.store.listConversations({ status: "active" })) {
      const awaited = c.awaitedRun;
      if (!awaited) continue;
      const run = this.lookupRun(awaited.runId);
      if (!run) {
        this.deps.store.setAwaitedRun?.(c.id, null);
        continue;
      }
      // Populate in-memory state FIRST — handleRunSettled finds conversations
      // via this map (proceed latches are empty after a restart) and clears
      // both stores when it delivers.
      this.awaitedRuns.set(c.id, awaited);
      if (!isBusyRunStage(run.stage)) {
        // Run settled while the server was down — deliver the missed notification
        void this.handleRunStageChanged(run);
        continue;
      }
      // Run still busy — re-establish the watcher
      this.watchRunForFollowUp(c, awaited.runId, awaited.kind);
    }
  }

  // ---- model management ----

  async listModels(): Promise<EndpointModelList[]> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    return listUniqueProviderModels(
      registry.listEndpoints(),
      fetch,
      10_000,
      registry.getProviders(),
    );
  }

  async listFunctionMappings(): Promise<FunctionMappingList> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const endpoints = registry.listEndpoints();
    const providersConfig = loadProvidersConfig(
      providersPathFromEndpoints(this.deps.endpointsPath),
    );
    const { catalogs } = await buildProviderCatalogs({
      endpoints,
      providersConfig,
    });
    return buildFunctionMappingList(
      {
        endpoints,
        roles: registry.getRoleBindings(),
      },
      catalogs,
    );
  }

  setConversationModel(
    conversationId: string,
    override: ChatConversation["modelOverride"],
  ): ChatConversation {
    const conversation = this.getConversation(conversationId);
    conversation.modelOverride = override;
    this.deps.store.updateConversation(conversation);
    return conversation;
  }

  updateEndpointDefaultModel(endpointId: string, modelId: string) {
    const config = updateEndpointModel({
      endpointsPath: this.deps.endpointsPath,
      endpointId,
      modelId,
    });
    this.deps.onEndpointsChanged?.();
    return config;
  }

  async bindFunctionMapping(opts: {
    function: AgentRole;
    modelId: string;
    provider?: string;
    endpointId?: string;
  }): Promise<BindFunctionResult> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const endpoints = registry.listEndpoints();
    const providersConfig = loadProvidersConfig(
      providersPathFromEndpoints(this.deps.endpointsPath),
    );
    const { catalogs } = await buildProviderCatalogs({
      endpoints,
      providersConfig,
    });
    const result = bindFunctionToModel({
      endpointsPath: this.deps.endpointsPath,
      function: opts.function,
      modelId: opts.modelId,
      provider: opts.provider,
      endpointId: opts.endpointId,
      providersConfig,
      catalogs,
    });
    this.deps.onEndpointsChanged?.();
    return result;
  }

  listToolSurface() {
    return listChatToolNames();
  }

  // ---- confirmation gate ----

  private requestConfirmation(
    conversation: ChatConversation,
    tool: string,
    args: Record<string, unknown>,
  ): { token: string } {
    const token = randomUUID();
    const now = Date.now();
    this.pending.set(token, {
      token,
      conversationId: conversation.id,
      tool,
      args,
      createdAt: now,
      expiresAt: now + this.confirmTimeoutMs,
    });
    this.emit(conversation, {
      type: "confirm_request",
      tool,
      token,
      argsPreview: JSON.stringify(args).slice(0, 400),
      summary: `${tool} awaits operator confirmation`,
    });
    return { token };
  }

  getPendingAction(token: string): PendingAction | undefined {
    const action = this.pending.get(token);
    if (!action) return undefined;
    if (Date.now() > action.expiresAt) {
      this.pending.delete(token);
      return undefined;
    }
    return action;
  }

  /**
   * Resolve a pending gated action. On approve, dispatches the tool and runs
   * a short synthetic turn so the agent thread records the outcome.
   * Pass skipSynthetic when the caller will continue the operator turn with
   * the result in the same prompt (in-chat confirm intercept).
   */
  async confirm(opts: {
    conversationId: string;
    token: string;
    approve: boolean;
    skipSynthetic?: boolean;
  }): Promise<{ ok: boolean; error?: string; reply?: string }> {
    const conversation = this.getConversation(opts.conversationId);
    const action = this.getPendingAction(opts.token);
    if (!action || action.conversationId !== conversation.id) {
      return { ok: false, error: "Unknown or expired confirmation token" };
    }
    this.pending.delete(opts.token);

    if (!opts.approve) {
      const deniedRunId =
        typeof action.args.runId === "string" ? action.args.runId.trim() : "";
      if (deniedRunId) {
        this.clearProceedLatch(conversation.id, deniedRunId);
      }
      this.emit(conversation, {
        type: "confirm_resolved",
        tool: action.tool,
        token: opts.token,
        approved: false,
      });
      const reply = `The operator denied the ${action.tool} action. Do not retry it unless they ask.`;
      if (!opts.skipSynthetic) {
        await this.runSyntheticTurn(
          conversation,
          `[operator DENIED the ${action.tool} action — do not retry it unless they ask]`,
        );
      }
      return { ok: true, reply };
    }

    this.trackLifecycleRunBeforeDispatch(conversation, action.tool, action.args);

    if (LIVE_TURN_ASYNC_TOOLS.has(action.tool)) {
      this.registerAwaitedLiveTurn(conversation, action.tool, action.args);
      this.runAsyncLiveTurnDispatch(conversation, action.tool, action.args);
      const text = liveTurnStartedMessage(action.tool);
      this.emit(conversation, {
        type: "confirm_resolved",
        tool: action.tool,
        token: opts.token,
        approved: true,
      });
      this.emit(conversation, {
        type: "tool_result",
        tool: action.tool,
        summary: text.slice(0, 200),
      });
      if (!opts.skipSynthetic) {
        await this.runSyntheticTurn(
          conversation,
          `[operator CONFIRMED ${action.tool}] ${text}`,
        );
      }
      return { ok: true, reply: text };
    }

    const result = await this.dispatchRouted(conversation, action.tool, action.args);
    let text = formatChatDispatchResult(result, action.tool);
    if (!result.isError) {
      this.trackLifecycleRunFromResult(conversation, action.tool, text);
      text = await this.maybeWaitForLifecycleRun(conversation, action.tool, text);
    }
    let failed = Boolean(result.isError);
    if (shouldAdvanceAfterConfirm(action.tool, action.args)) {
      const advanced = await this.maybeAdvanceRun(
        conversation,
        action.tool,
        action.args,
        text,
      );
      text = advanced.text;
      if (advanced.kind === "error") failed = true;
      else if (advanced.kind === "working") failed = false;
    }
    this.emit(conversation, {
      type: "confirm_resolved",
      tool: action.tool,
      token: opts.token,
      approved: true,
    });
    this.emit(conversation, {
      type: "tool_result",
      tool: action.tool,
      summary: failed ? `failed: ${text.slice(0, 200)}` : text.slice(0, 200),
    });
    if (!opts.skipSynthetic) {
      await this.runSyntheticTurn(
        conversation,
        `[operator CONFIRMED ${action.tool}] Result (isError=${failed}):\n${text}`,
      );
    }
    return { ok: !failed, error: failed ? text : undefined, reply: text };
  }

  listPendingForConversation(conversationId: string): PendingAction[] {
    const now = Date.now();
    const out: PendingAction[] = [];
    for (const [token, action] of this.pending) {
      if (action.conversationId !== conversationId) continue;
      if (now > action.expiresAt) {
        this.pending.delete(token);
        continue;
      }
      out.push(action);
    }
    return out;
  }

  /**
   * When gated actions are parked, classify the operator's next message.
   * Approve/deny goes through confirm(); unrelated leaves them parked.
   * Classifier throw → unrelated (never auto-approve).
   */
  private async maybeResolvePendingConfirm(
    conversation: ChatConversation,
    message: string,
  ): Promise<string | null> {
    const parked = this.listPendingForConversation(conversation.id);
    if (parked.length === 0) return null;

    const parkedForLlm: ParkedChatAction[] = parked.map((p) => ({
      token: p.token,
      tool: p.tool,
      argsPreview: JSON.stringify(p.args).slice(0, 400),
    }));

    let classified: ChatConfirmClassification;
    try {
      classified = this.deps.classifyConfirm
        ? await this.deps.classifyConfirm({
            message,
            parked: parkedForLlm,
          })
        : await this.classifyPendingViaLlm(message, parkedForLlm);
    } catch {
      return null;
    }
    if (classified.decision === "unrelated") return null;
    const token =
      classified.token ??
      (parked.length === 1 ? parked[0]!.token : undefined);
    if (!token) return null;
    const action = parked.find((p) => p.token === token);
    const confirmed = await this.confirm({
      conversationId: conversation.id,
      token,
      approve: classified.decision === "approve",
      skipSynthetic: true,
    });
    if (!confirmed.ok && classified.decision === "approve" && !confirmed.reply) {
      return buildConfirmedTurnPrefix({
        tool: action?.tool ?? "tool",
        approve: false,
        resultText: confirmed.error ?? "confirmation failed",
      });
    }
    return buildConfirmedTurnPrefix({
      tool: action?.tool ?? "tool",
      approve: classified.decision === "approve",
      resultText: confirmed.reply ?? confirmed.error ?? "",
    });
  }

  private async classifyPendingViaLlm(
    message: string,
    parked: ParkedChatAction[],
  ): Promise<ChatConfirmClassification> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const { endpoint, modelId } = registry.resolveEndpointForRole(
      "classification",
    );
    return classifyChatConfirmViaLlm({
      endpoint,
      modelId,
      message,
      parked,
    });
  }

  private resolveAskLatch(conversationId: string): AskResumeLatch | undefined {
    const latch = this.askLatches.get(conversationId);
    if (!latch) return undefined;
    const live = this.deps.context.getAsk?.(latch.askId);
    if (!live) return latch;
    return {
      ...latch,
      status: live.status,
      title: live.title ?? latch.title,
    };
  }

  private fillAskIdFromLatch(
    conversationId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!ASK_ID_DEPENDENT_TOOLS.has(tool)) return args;
    const existing =
      typeof args.askId === "string" ? args.askId.trim() : "";
    if (existing) return args;
    const latch = this.resolveAskLatch(conversationId);
    if (!latch?.askId) return args;
    return { ...args, askId: latch.askId };
  }

  private resolvePlanLatch(conversationId: string): PlanResumeLatch | undefined {
    return this.planLatches.get(conversationId);
  }

  private fillLoopIdFromLatch(
    conversationId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!PLAN_LOOP_ID_DEPENDENT_TOOLS.has(tool)) return args;
    const existing =
      typeof args.loopId === "string" ? args.loopId.trim() : "";
    if (existing) return args;
    const latch = this.resolvePlanLatch(conversationId);
    if (!latch?.loopId) return args;
    return { ...args, loopId: latch.loopId };
  }

  private backfillPlanAcceptArgs(
    tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (tool !== "plan_loop_accept") return args;
    if (hasPlanAcceptanceTicks(args)) return args;
    return { ...args, acceptAllFeatures: true };
  }

  private fillLatchedToolArgs(
    conversationId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    let next = this.fillAskIdFromLatch(conversationId, tool, args);
    next = this.fillLoopIdFromLatch(conversationId, tool, next);
    next = this.backfillPlanAcceptArgs(tool, next);
    return next;
  }

  /**
   * LLM classification for ask continue-vs-new. Throws on LLM/parse failure
   * so the caller can fall back to deterministic heuristics.
   */
  private async classifyAskResumeDecision(opts: {
    message: string;
    latch: AskResumeLatch;
  }): Promise<"continue" | "new"> {
    const classified = this.deps.classifyAskResume
      ? await this.deps.classifyAskResume({
          message: opts.message,
          latchTitle: opts.latch.title,
          latchLastUser: opts.latch.lastUserLine,
        })
      : await this.classifyAskResumeViaLlm(opts.message, opts.latch);
    return classified.decision === "continue" ? "continue" : "new";
  }

  private async classifyAskResumeViaLlm(
    message: string,
    latch: AskResumeLatch,
  ): Promise<AskResumeClassification> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const { endpoint, modelId } = registry.resolveEndpointForRole(
      "classification",
    );
    return classifyAskResumeViaLlm({
      endpoint,
      modelId,
      message,
      latchTitle: latch.title,
      latchLastUser: latch.lastUserLine,
    });
  }

  /**
   * Chat-originated ask never falls through to project latestOpenAsk.
   * Always sends askId or newAsk=true. Ask-id dependents fill from this
   * conversation's latch when omitted.
   */
  private async dispatchRouted(
    conversation: ChatConversation,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ChatToolResult> {
    let nextArgs = args;
    if (name === "ask") {
      nextArgs = await this.routeAskArgs(conversation, args);
    } else if (name === "plan_loop_start" || name === "design_loop_start") {
      nextArgs = backfillLoopStartBrief(
        args,
        this.turnOperatorMessage.trim(),
      );
      const brief =
        typeof nextArgs.brief === "string" ? nextArgs.brief.trim() : "";
      if (!brief) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `${name} requires brief — pass the operator's planning words in brief.`,
            },
          ],
        };
      }
    } else if (ASK_ID_DEPENDENT_TOOLS.has(name)) {
      nextArgs = this.fillAskIdFromLatch(conversation.id, name, args);
      const filled =
        typeof nextArgs.askId === "string" ? nextArgs.askId.trim() : "";
      if (!filled) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No askId: this chat has no latched ask. Call ask first or pass askId.",
            },
          ],
        };
      }
    } else if (PLAN_LOOP_ID_DEPENDENT_TOOLS.has(name)) {
      nextArgs = this.fillLoopIdFromLatch(conversation.id, name, args);
      nextArgs = this.backfillPlanAcceptArgs(name, nextArgs);
      const filled =
        typeof nextArgs.loopId === "string" ? nextArgs.loopId.trim() : "";
      if (!filled) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "No loopId: this chat has no latched plan loop. Call plan_loop_start first or pass loopId.",
            },
          ],
        };
      }
    } else if (name === "start_change") {
      let description =
        typeof nextArgs.description === "string" ? nextArgs.description.trim() : "";
      if (!description) {
        const messages = await this.getMessages(conversation.id);
        description =
          buildChatTaskDescription(messages, {
            operatorMessage: this.turnOperatorMessage.trim(),
          }) ?? "";
        nextArgs = { ...nextArgs, description };
      }
      if (!description) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "start_change requires description — pass the operator's full task brief, or ensure the chat contains a substantive task message before handing over.",
            },
          ],
        };
      }
    }

    const result = await this.deps.dispatch(name, nextArgs);
    if (!result.isError) {
      this.rememberAskFromDispatch(conversation, name, nextArgs, result);
      this.rememberPlanFromDispatch(conversation, name, nextArgs, result);
    }
    return result;
  }

  private async routeAskArgs(
    conversation: ChatConversation,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const operatorMessage =
      this.turnOperatorMessage.trim() ||
      (typeof args.message === "string" ? args.message : "");
    const latch = this.resolveAskLatch(conversation.id);

    // LLM-first: classify continue-vs-new via the classification role.
    // Regex heuristics (decideAskResume) are fallback only on LLM failure.
    let decision: { kind: "continue"; askId: string; reason: string } | { kind: "new"; title: string; reason: string };
    if (latch?.askId && isAskOpen(latch.status)) {
      try {
        const classified = await this.classifyAskResumeDecision({
          message: operatorMessage,
          latch,
        });
        decision =
          classified === "continue"
            ? {
                kind: "continue",
                askId: latch.askId,
                reason: "classifier continue",
              }
            : {
                kind: "new",
                title:
                  (typeof args.title === "string" && args.title.trim()) ||
                  operatorMessage.split("\n")[0]?.slice(0, 80) ||
                  "New investigation",
                reason: "classifier new",
              };
      } catch {
        // LLM failed — fall back to deterministic heuristics
        const fallback = decideAskResume({
          operatorMessage,
          args: {
            askId: typeof args.askId === "string" ? args.askId : undefined,
            newAsk: args.newAsk === true,
            title: typeof args.title === "string" ? args.title : undefined,
            message: typeof args.message === "string" ? args.message : undefined,
          },
          latch,
        });
        if (fallback.kind === "continue") {
          decision = {
            kind: "continue",
            askId: fallback.askId,
            reason: `fallback: ${fallback.reason}`,
          };
        } else if (fallback.kind === "new") {
          decision = {
            kind: "new",
            title: fallback.title,
            reason: `fallback: ${fallback.reason}`,
          };
        } else {
          // ambiguous even in fallback — fail closed to new
          decision = {
            kind: "new",
            title:
              (typeof args.title === "string" && args.title.trim()) ||
              operatorMessage.split("\n")[0]?.slice(0, 80) ||
              "New investigation",
            reason: "fallback ambiguous",
          };
        }
      }
    } else {
      // No open latch — always start a new ask
      decision = {
        kind: "new",
        title:
          (typeof args.title === "string" && args.title.trim()) ||
          operatorMessage.split("\n")[0]?.slice(0, 80) ||
          "New investigation",
        reason: latch?.askId ? `latch not open (${latch.status})` : "no latch",
      };
    }
    this.emit(conversation, {
      type: "status",
      summary:
        decision.kind === "continue"
          ? `continuing ask ${decision.askId}`
          : `starting new ask: ${decision.title}`,
    });
    const routed = applyAskResumeDecision(decision, args);
    const composed = composeAskDispatchMessage({
      operatorMessage,
      chatMessage:
        typeof args.message === "string" ? args.message : undefined,
      priorOperatorQuestion: latch?.lastUserLine,
    });
    if (composed) {
      return { ...routed, message: composed };
    }
    return routed;
  }

  private rememberAskFromDispatch(
    conversation: ChatConversation,
    name: string,
    args: Record<string, unknown>,
    result: ChatToolResult,
  ): void {
    const raw = result.content.map((c) => c.text).join("\n");
    if (name === "promote_ask") {
      const id =
        parseAskIdFromDispatch(raw) ||
        (typeof args.askId === "string" ? args.askId : "");
      const latch = this.askLatches.get(conversation.id);
      if (latch && (!id || latch.askId === id)) {
        this.askLatches.delete(conversation.id);
      }
      return;
    }
    if (name !== "ask" && name !== "fork_ask") return;
    const askId = parseAskIdFromDispatch(raw);
    if (!askId) return;
    const status = parseAskStatusFromDispatch(raw);
    const title =
      typeof args.title === "string" && args.title.trim()
        ? args.title.trim()
        : this.askLatches.get(conversation.id)?.title;
    this.askLatches.set(conversation.id, {
      askId,
      title,
      lastUserLine: this.turnOperatorMessage.trim() || undefined,
      status: status || "open",
    });
  }

  private rememberPlanFromDispatch(
    conversation: ChatConversation,
    name: string,
    args: Record<string, unknown>,
    result: ChatToolResult,
  ): void {
    const raw = result.content.map((c) => c.text).join("\n");
    if (name === "plan_loop_promote") {
      const id =
        parseLoopIdFromDispatch(raw) ||
        (typeof args.loopId === "string" ? args.loopId : "");
      const latch = this.planLatches.get(conversation.id);
      if (latch && (!id || latch.loopId === id)) {
        this.planLatches.delete(conversation.id);
      }
      return;
    }
    if (
      name !== "plan_loop_start" &&
      name !== "plan_loop_continue" &&
      name !== "plan_loop_accept"
    ) {
      return;
    }
    const loopId =
      parseLoopIdFromDispatch(raw) ||
      (typeof args.loopId === "string" ? args.loopId.trim() : "");
    if (!loopId) return;
    const status = parsePlanLoopStatusFromDispatch(raw);
    const title =
      typeof args.brief === "string" && args.brief.trim()
        ? args.brief.trim().split("\n")[0]?.slice(0, 80)
        : this.planLatches.get(conversation.id)?.title;
    this.planLatches.set(conversation.id, {
      loopId,
      title,
      status: status || (name === "plan_loop_accept" ? "accepted" : "open"),
    });
  }

  private lookupRun(runId: string) {
    return this.deps.context.listRuns().find((run) => run.id === runId);
  }

  private proceedLatchKey(conversationId: string, runId: string): string {
    return `${conversationId}:${runId}`;
  }

  private setProceedLatch(
    conversation: ChatConversation,
    runId: string,
    args: Record<string, unknown>,
  ): void {
    const projectId =
      (typeof args.projectId === "string" && args.projectId) ||
      conversation.projectId ||
      undefined;
    this.proceedLatches.set(this.proceedLatchKey(conversation.id, runId), {
      conversationId: conversation.id,
      runId,
      projectId,
    });
  }

  private clearProceedLatch(conversationId: string, runId: string): void {
    this.proceedLatches.delete(this.proceedLatchKey(conversationId, runId));
  }

  private clearProceedLatchesForConversation(conversationId: string): void {
    for (const [key, latch] of this.proceedLatches) {
      if (latch.conversationId === conversationId) {
        this.proceedLatches.delete(key);
      }
    }
  }

  /**
   * After the operator confirms a proceed action, keep walking the run
   * until work is running (or a real stop). Table-driven — do not add
   * one-off tool pairs here.
   */
  private async maybeAdvanceRun(
    conversation: ChatConversation,
    tool: string,
    args: Record<string, unknown>,
    resultText: string,
    opts?: { skipFollowUpWait?: boolean },
  ): Promise<{ text: string; kind: "working" | "stop" | "error"; stage?: string }> {
    const runId = runIdFromLifecycle(args, resultText);
    if (!runId) {
      return { text: resultText, kind: "stop" };
    }
    this.setProceedLatch(conversation, runId, args);
    let knownStage = stageFromDispatchText(resultText);
    if (!knownStage && tool === "submit_review" && args.decision === "approve") {
      knownStage = "accepted";
    }
    const projectId =
      (typeof args.projectId === "string" && args.projectId) ||
      conversation.projectId ||
      undefined;

    const advanced = await advanceRun({
      runId,
      projectId,
      stageHint: knownStage,
      seedError: resultText.startsWith("ERROR:") ? resultText : undefined,
      getStage: () => this.lookupRun(runId)?.stage ?? knownStage,
      dispatch: async (nextTool, nextArgs) => {
        const follow = await this.deps.dispatch(nextTool, nextArgs);
        let followText = formatChatDispatchResult(follow, nextTool);
        if (!follow.isError) {
          followText = await this.maybeWaitForLifecycleRun(
            conversation,
            nextTool,
            followText,
            { skipFollowUp: opts?.skipFollowUpWait },
          );
          knownStage =
            stageFromDispatchText(followText) ??
            this.lookupRun(runId)?.stage ??
            knownStage;
        }
        this.emit(conversation, {
          type: "tool_result",
          tool: nextTool,
          summary: follow.isError
            ? `failed: ${followText.slice(0, 200)}`
            : followText.slice(0, 200),
        });
        return { text: followText, isError: follow.isError };
      },
    });

    if (isTerminalRunStage(advanced.stage)) {
      this.clearProceedLatch(conversation.id, runId);
    }
    if (advanced.steps.length === 0) {
      return { text: resultText, kind: advanced.kind, stage: advanced.stage };
    }
    return {
      text: `${resultText.trim()}\n\n${formatAdvanceRunResult(advanced)}`,
      kind: advanced.kind,
      stage: advanced.stage,
    };
  }

  private async maybeWaitForLifecycleRun(
    conversation: ChatConversation,
    tool: string,
    resultText: string,
    opts?: { skipFollowUp?: boolean },
  ): Promise<string> {
    if (!LIFECYCLE_WAIT_TOOLS.has(tool)) return resultText;
    const extracted = extractBusyRunFromLifecycleResult(resultText);
    if (!extracted || !isBusyRunStage(extracted.stage)) return resultText;

    const kind = runWaitKindForTool(tool) ?? "develop";
    const config = this.waitConfigFor(kind);

    if (!this.awaitedRuns.has(conversation.id)) {
      const projectId =
        conversation.projectId ??
        this.lookupRun(extracted.runId)?.projectId ??
        extracted.runId;
      this.registerAwaitedRun(conversation, extracted.runId, kind);
    }

    const wait = await waitForRun({
      runId: extracted.runId,
      getRun: () => this.lookupRun(extracted.runId),
      timeoutMs: config.inlineMs,
      intervalMs: this.waitPollMs,
      subscribeRun: this.deps.subscribeRunUpdates
        ? (id, listener) =>
            this.deps.subscribeRunUpdates!(id, () => listener())
        : undefined,
    });

    if (wait.settled) {
      await this.completeAwaitedRunForConversation(
        conversation,
        extracted.runId,
        {
          stage: wait.stage,
          phaseId: wait.phaseId,
          projectId: wait.projectId,
          elapsedMs: wait.elapsedMs,
        },
        kind,
      );
    } else if (wait.timedOut && config.followUpMs > 0 && !opts?.skipFollowUp) {
      this.watchRunForFollowUp(conversation, extracted.runId, kind);
    }
    return `${resultText.trim()}\n\n${formatWaitForRunResult(wait, this.runSettledContext())}`;
  }

  /**
   * wait_for_run is a free tool: it self-executes in the agent loop and its
   * still-busy result is the model promising "I'll let you know". Back that
   * promise with the same awaited-run + follow-up watcher machinery the
   * lifecycle tools get, or the chat goes silent when the run settles.
   */
  private maybeWatchFromWaitForRun(
    conversation: ChatConversation,
    rawText: string,
  ): void {
    let parsed: {
      runId?: unknown;
      stage?: unknown;
      settled?: unknown;
      projectId?: unknown;
    };
    try {
      parsed = JSON.parse(rawText.trim());
    } catch {
      return;
    }
    if (parsed.settled !== false) return;
    const runId = typeof parsed.runId === "string" ? parsed.runId : "";
    const stage = typeof parsed.stage === "string" ? parsed.stage : "";
    if (!runId || !isBusyRunStage(stage)) return;

    const kind = runWaitKindForStage(stage);
    const projectId =
      conversation.projectId ??
      (typeof parsed.projectId === "string" ? parsed.projectId : undefined) ??
      this.lookupRun(runId)?.projectId ??
      runId;
    const awaited: AwaitedRun = {
      runId,
      projectId,
      kind,
      startedAt: new Date().toISOString(),
    };
    this.awaitedRuns.set(conversation.id, awaited);
    this.deps.store.setAwaitedRun?.(conversation.id, awaited);
    this.bumpConversationActivity(conversation.id);
    this.emit(conversation, {
      type: "run_awaited",
      summary: `waiting for ${kind} run ${runId}…`,
      run: { runId, projectId, stage, kind },
    });
    // Replaces any existing watcher for this run (abort + fresh window).
    this.watchRunForFollowUp(conversation, runId, kind);
  }

  private watchRunForFollowUp(
    conversation: ChatConversation,
    runId: string,
    kind: RunWaitKind = "develop",
  ): void {    const key = `${conversation.id}:${runId}`;
    this.runWatchers.get(key)?.abort();
    const abort = new AbortController();
    this.runWatchers.set(key, abort);
    const config = this.waitConfigFor(kind);
    // Relative to waitForRun's own clock — comparing elapsedMs against a
    // Date.now() timestamp would suppress progress events forever.
    let lastProgressEmit = 0;

    void (async () => {
      let reschedule = false;
      try {
        const wait = await waitForRun({
          runId,
          getRun: () => this.lookupRun(runId),
          timeoutMs: config.followUpMs,
          intervalMs: this.waitPollMs,
          signal: abort.signal,
          subscribeRun: this.deps.subscribeRunUpdates
            ? (id, listener) =>
                this.deps.subscribeRunUpdates!(id, () => listener())
            : undefined,
          onProgress: (snap, elapsedMs) => {
            // Emit periodic run_progress events for dashboard display
            if (elapsedMs - lastProgressEmit >= config.progressIntervalMs) {
              lastProgressEmit = elapsedMs;
              this.emit(conversation, {
                type: "run_progress",
                summary: `${snap.stage} (${Math.round(elapsedMs / 1000)}s)`,
                run: {
                  runId,
                  projectId: snap.projectId,
                  stage: snap.stage,
                  kind,
                  elapsedMs,
                },
              });
            }
          },
        });

        const latest = this.deps.store.getConversation(conversation.id);
        if (abort.signal.aborted) {
          // Replaced by a newer watcher (or handleRunSettled) mid-poll —
          // that owner emits the settlement; this one must stay silent.
          return;
        }
        if (!latest || latest.status === "closed") {
          this.awaitedRuns.delete(conversation.id);
          this.deps.store.setAwaitedRun?.(conversation.id, null);
          return;
        }

        if (!wait.settled) {
          // Follow-up timed out — emit progress with timedOut flag so the
          // dashboard can show "still working (asked 62min ago)" rather than
          // silence. The operator can still query status via MCP.
          this.emit(latest, {
            type: "run_progress",
            summary: `still ${wait.stage} after ${Math.round(wait.elapsedMs / 1000)}s (follow-up wait exhausted)`,
            run: {
              runId,
              projectId: wait.projectId,
              stage: wait.stage,
              kind,
              elapsedMs: wait.elapsedMs,
              timedOut: true,
            },
          });
          return;
        }

        // Run settled — poll fallback when event path did not fire first
        reschedule = await this.completeAwaitedRunForConversation(
          latest,
          runId,
          {
            stage: wait.stage,
            phaseId: wait.phaseId,
            projectId: wait.projectId,
            elapsedMs: wait.elapsedMs,
          },
          kind,
        );
      } catch {
        /* aborted or follow-up turn failed — operator can ask */
      } finally {
        // Only delete if we still own the key — a replacement watcher
        // registered under the same key must not be clobbered.
        if (this.runWatchers.get(key) === abort) {
          this.runWatchers.delete(key);
        }
      }
      if (reschedule) {
        this.watchRunForFollowUp(conversation, runId, kind);
      }
    })();
  }

  /**
   * Drain the notification queue for a conversation. Delivers pending
   * notifications via memory append + SSE (no LLM).
   */
  private drainNotificationQueue(conversationId: string): void {
    const notes = this.notificationQueue.get(conversationId);
    if (!notes || notes.length === 0) return;
    this.notificationQueue.delete(conversationId);

    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation || conversation.status === "closed") return;

    void (async () => {
      for (const note of notes) {
        try {
          await this.deliverSystemNotification(
            conversation,
            note,
            formatRunNotificationBrief(note),
          );
        } catch {
          /* best-effort notification */
        }
      }
    })();
  }

  /** Record a gated-action outcome in Memory without an LLM turn. */
  private async runSyntheticTurn(
    conversation: ChatConversation,
    note: string,
  ): Promise<void> {
    try {
      await this.deliverSystemNotification(
        conversation,
        note,
        formatRunNotificationBrief(note),
      );
    } catch {
      /* synthetic acknowledgement is best-effort */
    }
  }

  // ---- turns ----

  /**
   * Send an operator message and stream the turn. Events are both published
   * to subscribers and returned via the async iterator.
   */
  async *sendMessage(
    conversationId: string,
    text: string,
  ): AsyncIterable<ChatEvent> {
    const conversation = this.getConversation(conversationId);
    if (conversation.status === "closed") {
      throw new ConversationClosedError(conversationId);
    }
    this.deps.store.touchConversation(conversationId, text);
    this.turnOperatorMessage = text;

    const queue: ChatEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((event) => {
      if (event.conversationId !== conversationId) return;
      queue.push(event);
      wake?.();
    });

    try {
      const confirmPrefix = await this.maybeResolvePendingConfirm(
        conversation,
        text,
      );
      const turnText = confirmPrefix
        ? `${confirmPrefix}\n\n---\nOperator message:\n${text}`
        : text;
      const turn = this.runTurn(conversation, turnText, { synthetic: false });
      let done = false;
      let turnError: unknown = null;
      void turn
        .catch((err) => {
          turnError = err;
        })
        .finally(() => {
          done = true;
          wake?.();
        });
      while (!done || queue.length > 0) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 250);
        });
      }
      if (turnError) throw turnError;
    } finally {
      this.turnOperatorMessage = "";
      unsubscribe();
    }
  }

  private async runTurn(
    conversation: ChatConversation,
    text: string,
    opts: { synthetic: boolean },
  ): Promise<void> {
    this.busyConversations.add(conversation.id);
    try {
      await this.runTurnBody(conversation, text, opts);
    } finally {
      this.busyConversations.delete(conversation.id);
      // Drain any notifications that queued up while this turn was running
      if (!this.busyConversations.has(conversation.id)) {
        this.drainNotificationQueue(conversation.id);
      }
    }
  }

  private async runTurnBody(
    conversation: ChatConversation,
    text: string,
    opts: { synthetic: boolean },
  ): Promise<void> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const toolGuard = createToolCallGuard({
      hasActiveLiveTurn: (loopId) =>
        this.hasActiveLiveTurn(conversation.id, loopId),
    });
    const override = conversation.modelOverride;
    const model = override
      ? resolveConversationModelOverride(registry, override)
      : registry.resolve("chat");

    const pendingActions = this.listPendingForConversation(conversation.id).map(
      (p) => ({
        token: p.token,
        tool: p.tool,
        argsPreview: JSON.stringify(p.args).slice(0, 400),
      }),
    );
    const projectKnowledge = conversation.projectId
      ? await recallProjectKnowledge({
          memory: this.deps.getMemory(),
          projectId: conversation.projectId,
        })
      : "";
    const systemPrompt = conversation.projectId
      ? buildProjectChatPrompt({
          project: this.deps.context.getProject(conversation.projectId)!,
          deps: this.deps.context,
          pendingActions,
          projectKnowledge,
        })
      : buildGlobalChatPrompt({
          deps: this.deps.context,
          pendingActions,
        });

    const tools = buildChatTools({
      dispatch: (name, args) => {
        const blocked = toolGuard.check(name, args);
        if (blocked) {
          return Promise.resolve({
            content: [{ type: "text" as const, text: blocked }],
            isError: true,
          });
        }
        return this.dispatchRouted(conversation, name, args);
      },
      conversationId: conversation.id,
      projectId: conversation.projectId,
      requestConfirmation: (tool, args) =>
        this.requestConfirmation(
          conversation,
          tool,
          this.fillLatchedToolArgs(conversation.id, tool, args),
        ),
      onFreeToolResult: (name, _args, rawText, isError) => {
        if (isError || name !== "wait_for_run") return;
        this.maybeWatchFromWaitForRun(conversation, rawText);
      },
    });

    const agent = new Agent({
      id: "chat-operator",
      name: "Chat Operator",
      instructions: systemPrompt,
      model,
      memory: this.deps.getMemory(),
      tools,
    });

    this.emit(conversation, {
      type: "status",
      summary: opts.synthetic ? "recording confirmed action" : "turn started",
    });

    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort(new Error(`chat turn timed out after ${this.turnTimeoutMs}ms`));
    }, this.turnTimeoutMs);

    const runStreamOn = async (threadId: string): Promise<void> => {
      const streamResult = await agent.stream(text, {
        maxSteps: opts.synthetic ? SYSTEM_TURN_MAX_STEPS : MAX_STEPS,
        ...(opts.synthetic ? { activeTools: [] as string[] } : {}),
        abortSignal: abort.signal,
        memory: {
          thread: threadId,
          resource: conversation.projectId ?? "global",
        },
      });

      let reply = "";
      let toolCallCount = 0;
      const fullStream = (
        streamResult as { fullStream?: AsyncIterable<unknown> }
      ).fullStream;
      if (fullStream) {
        for await (const chunk of fullStream) {
          for (const ev of askProgressFromStreamChunk(chunk)) {
            if (ev.type === "text") {
              reply += ev.text;
              this.emit(conversation, { type: "delta", text: ev.text });
            } else if (ev.type === "tool_call") {
              toolCallCount += 1;
              this.emit(conversation, {
                type: "tool_call",
                tool: ev.tool,
                summary: ev.summary,
              });
            } else if (ev.type === "tool_result") {
              this.emit(conversation, {
                type: "tool_result",
                tool: ev.tool,
                summary: ev.summary,
              });
            }
          }
        }
      }

      const finalText = await Promise.resolve(
        (streamResult as { text?: Promise<string> | string }).text,
      ).catch(() => "");
      let trimmed = (finalText || reply).trim();

      if (!opts.synthetic) {
        const narration = await decideNarrationSynthesis({
          reply: trimmed,
          toolCallCount,
          synthesizeIfNarration: true,
        });
        if (narration.synthesize) {
          this.emit(conversation, {
            type: "status",
            summary: "synthesizing answer from tool findings",
          });
          try {
            const synthResult = await agent.generate(
              `${ASK_SYNTHESIS_PROMPT_PREFIX}

---
${text}

---
Draft / incomplete reply to replace:
${trimmed.slice(0, 2_000) || "(empty)"}`,
              {
                maxSteps: 1,
                activeTools: [],
                abortSignal: abort.signal,
                memory: {
                  thread: `${threadId}-synth`,
                  resource: conversation.projectId ?? "global",
                },
              },
            );
            const synthText = String(
              await Promise.resolve(
                (synthResult as { text?: Promise<string> | string }).text,
              ).catch(() => ""),
            ).trim();
            if (synthText) {
              this.emit(conversation, { type: "delta", text: synthText });
              trimmed = synthText;
            }
          } catch {
            /* keep the streamed draft */
          }
        }
      }

      this.emit(conversation, { type: "done", text: trimmed });
    };

    try {
      await runStreamOn(conversation.id);
    } catch (err) {
      if (isPromptTooLongError(err)) {
        // The Memory thread accumulated oversized tool payloads — retry once
        // on a fresh thread so the conversation recovers instead of failing
        // forever. History is bypassed, not deleted.
        this.emit(conversation, {
          type: "status",
          summary: "context overflow — retrying on a fresh thread (history bypassed)",
        });
        try {
          await runStreamOn(`${conversation.id}-fresh-${Date.now()}`);
          return;
        } catch (retryErr) {
          const message =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          this.emit(conversation, { type: "error", error: message });
          throw retryErr;
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emit(conversation, { type: "error", error: message });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toTranscriptMessage(row: unknown): ChatTranscriptMessage | null {
  if (!row || typeof row !== "object") return null;
  const msg = row as {
    role?: string;
    createdAt?: string | Date | number;
    content?: unknown;
  };
  if (msg.role !== "user" && msg.role !== "assistant") return null;
  const content = extractTextContent(msg.content);
  if (!content) return null;
  return {
    role: msg.role,
    content,
    at: toIso(msg.createdAt),
  };
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";
  const obj = content as { parts?: unknown; text?: unknown; content?: unknown };
  if (typeof obj.text === "string") return obj.text.trim();
  if (Array.isArray(obj.parts)) {
    const texts = obj.parts
      .filter(
        (p): p is { type: string; text: string } =>
          Boolean(p) &&
          typeof p === "object" &&
          (p as { type?: string }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text);
    return texts.join("\n").trim();
  }
  if (typeof obj.content === "string") return obj.content.trim();
  return "";
}

function toIso(value: string | Date | number | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return value;
  }
  return new Date().toISOString();
}

/** Prefix the operator turn so a just-dispatched gated result is the answer, not a buried memory note. */
export function buildConfirmedTurnPrefix(opts: {
  tool: string;
  approve: boolean;
  resultText: string;
}): string {
  if (!opts.approve) {
    return `[The parked ${opts.tool} action was denied. Do not retry it unless the operator asks. ${opts.resultText}]`;
  }
  return `[The parked ${opts.tool} action was approved and has finished. Answer the operator from this result. Do not call ${opts.tool} again for the same question unless you need a genuine follow-up.]

${opts.resultText.trim()}`;
}
