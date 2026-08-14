import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import {
  classifyAskResumeViaLlm,
  classifyChatConfirmViaLlm,
  LlmRegistry,
  toMastraModelConfig,
  type AskResumeClassification,
  type ChatConfirmClassification,
  type ParkedChatAction,
} from "@slopcontrol/llm";
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
  listUniqueProviderModels,
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
  DEFAULT_FOLLOW_UP_WAIT_MS,
  DEFAULT_WAIT_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  LIFECYCLE_WAIT_TOOLS,
  extractBusyRunFromLifecycleResult,
  formatWaitForRunResult,
  isBusyRunStage,
  waitForRun,
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
import type {
  ChatContextDeps,
  ChatEvent,
  ChatEventListener,
  ChatToolDispatch,
  ChatToolResult,
  ChatTranscriptMessage,
  ConversationStore,
  PendingAction,
} from "./types.js";

const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_TURN_TIMEOUT_MS = 720_000;
const MAX_STEPS = 16;

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
  private readonly runWatchers = new Map<string, AbortController>();
  private readonly busyConversations = new Set<string>();
  /** Operator said proceed — keep reconciling until busy-or-human-stop. */
  private readonly proceedLatches = new Map<
    string,
    { conversationId: string; runId: string; projectId?: string }
  >();
  /** Last ask this conversation started or continued — not project latestOpenAsk. */
  private readonly askLatches = new Map<string, AskResumeLatch>();
  /** Operator utterance for the in-flight sendMessage (ask routing). */
  private turnOperatorMessage = "";

  constructor(private readonly deps: ChatServiceDeps) {
    this.emitter.setMaxListeners(100);
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.waitPollMs = deps.waitPollMs ?? DEFAULT_WAIT_INTERVAL_MS;
    this.followUpWaitMs = deps.followUpWaitMs ?? DEFAULT_FOLLOW_UP_WAIT_MS;
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
    const closed = this.deps.store.closeConversation(id) ?? conversation;
    this.emit(closed, { type: "closed" });
    return closed;
  }

  deleteConversation(id: string): boolean {
    const conversation = this.deps.store.getConversation(id);
    if (!conversation) return false;
    this.clearProceedLatchesForConversation(id);
    this.askLatches.delete(id);
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

  /** Idle sweep: close active conversations past maxIdleMs. Returns closed. */
  closeIdleConversations(maxIdleMs: number, now: Date = new Date()): string[] {
    const closed: string[] = [];
    for (const c of this.deps.store.listConversations({ status: "active" })) {
      const idleMs = now.getTime() - Date.parse(c.lastActiveAt);
      if (idleMs < maxIdleMs) continue;
      this.clearProceedLatchesForConversation(c.id);
      this.askLatches.delete(c.id);
      this.deps.store.closeConversation(c.id);
      this.emit(c, { type: "closed", summary: "idle timeout" });
      closed.push(c.id);
    }
    return closed;
  }

  // ---- model management ----

  async listModels(): Promise<EndpointModelList[]> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    return listUniqueProviderModels(registry.listEndpoints());
  }

  async listFunctionMappings(): Promise<FunctionMappingList> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const endpoints = registry.listEndpoints();
    const providers = await listUniqueProviderModels(endpoints);
    return buildFunctionMappingList(
      {
        endpoints,
        roles: registry.getRoleBindings(),
      },
      providers,
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
    endpointId?: string;
  }): Promise<BindFunctionResult> {
    const providers = await this.listModels();
    const result = bindFunctionToModel({
      endpointsPath: this.deps.endpointsPath,
      function: opts.function,
      modelId: opts.modelId,
      endpointId: opts.endpointId,
      providers,
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

    const result = await this.dispatchRouted(conversation, action.tool, action.args);
    let text = formatChatDispatchResult(result, action.tool);
    if (!result.isError) {
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
    }

    const result = await this.deps.dispatch(name, nextArgs);
    if (!result.isError) {
      this.rememberAskFromDispatch(conversation, name, nextArgs, result);
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

    const wait = await waitForRun({
      runId: extracted.runId,
      getRun: () => this.lookupRun(extracted.runId),
      timeoutMs: this.waitTimeoutMs,
      intervalMs: this.waitPollMs,
      onProgress: (snap) => {
        this.emit(conversation, {
          type: "status",
          summary: `${snap.stage}…`,
        });
      },
    });
    if (wait.timedOut && this.followUpWaitMs > 0 && !opts?.skipFollowUp) {
      this.watchRunForFollowUp(conversation, extracted.runId);
    }
    return `${resultText.trim()}\n\n${formatWaitForRunResult(wait)}`;
  }

  private watchRunForFollowUp(
    conversation: ChatConversation,
    runId: string,
  ): void {
    const key = `${conversation.id}:${runId}`;
    this.runWatchers.get(key)?.abort();
    const abort = new AbortController();
    this.runWatchers.set(key, abort);
    void (async () => {
      let reschedule = false;
      try {
        const wait = await waitForRun({
          runId,
          getRun: () => this.lookupRun(runId),
          timeoutMs: this.followUpWaitMs,
          intervalMs: this.waitPollMs,
          signal: abort.signal,
          onProgress: (snap) => {
            this.emit(conversation, {
              type: "status",
              summary: `${snap.stage}…`,
            });
          },
        });
        if (!wait.settled) return;
        const latest = this.deps.store.getConversation(conversation.id);
        if (!latest || latest.status === "closed") return;
        this.emit(latest, {
          type: "status",
          summary: `run reached ${wait.stage}`,
        });
        while (this.busyConversations.has(latest.id)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (isTerminalRunStage(wait.stage)) {
          this.clearProceedLatch(latest.id, runId);
        }
        const latch = this.proceedLatches.get(
          this.proceedLatchKey(latest.id, runId),
        );
        let extra = "";
        if (latch && isGateRunStage(wait.stage)) {
          const advanced = await this.maybeAdvanceRun(
            latest,
            "advance_run",
            {
              runId,
              ...(latch.projectId ? { projectId: latch.projectId } : {}),
            },
            JSON.stringify({ runId, stage: wait.stage }),
            { skipFollowUpWait: true },
          );
          extra = `\n\n${advanced.text}`;
          const live = this.lookupRun(runId);
          if (isTerminalRunStage(live?.stage) || isTerminalRunStage(advanced.stage)) {
            this.clearProceedLatch(latest.id, runId);
          } else if (
            live &&
            isBusyRunStage(live.stage) &&
            this.followUpWaitMs > 0
          ) {
            reschedule = true;
          }
        }
        await this.runTurn(
          latest,
          `[Run ${runId} reached ${wait.stage}. ${formatWaitForRunResult(wait)}]${extra}`,
          { synthetic: false },
        );
      } catch {
        /* aborted or follow-up turn failed — operator can ask */
      } finally {
        this.runWatchers.delete(key);
      }
      if (reschedule) {
        this.watchRunForFollowUp(conversation, runId);
      }
    })();
  }

  /** Keep the Memory thread truthful after a gated action resolves. */
  private async runSyntheticTurn(
    conversation: ChatConversation,
    note: string,
  ): Promise<void> {
    try {
      await this.runTurn(conversation, note, { synthetic: true });
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
    }
  }

  private async runTurnBody(
    conversation: ChatConversation,
    text: string,
    opts: { synthetic: boolean },
  ): Promise<void> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const override = conversation.modelOverride;
    const model = override
      ? toMastraModelConfig(registry.getEndpoint(override.endpointId), override.modelId)
      : registry.resolve("chat");

    const pendingActions = this.listPendingForConversation(conversation.id).map(
      (p) => ({
        token: p.token,
        tool: p.tool,
        argsPreview: JSON.stringify(p.args).slice(0, 400),
      }),
    );
    const systemPrompt = conversation.projectId
      ? buildProjectChatPrompt({
          project: this.deps.context.getProject(conversation.projectId)!,
          deps: this.deps.context,
          pendingActions,
        })
      : buildGlobalChatPrompt({
          deps: this.deps.context,
          pendingActions,
        });

    const tools = buildChatTools({
      dispatch: (name, args) => this.dispatchRouted(conversation, name, args),
      conversationId: conversation.id,
      projectId: conversation.projectId,
      requestConfirmation: (tool, args) =>
        this.requestConfirmation(
          conversation,
          tool,
          this.fillAskIdFromLatch(conversation.id, tool, args),
        ),
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
        maxSteps: MAX_STEPS,
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
