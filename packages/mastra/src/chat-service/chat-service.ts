import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import { LlmRegistry, toMastraModelConfig } from "@slopcontrol/llm";
import type { ChatConversation } from "@slopcontrol/types";
import { askProgressFromStreamChunk } from "../orchestrator/ask-stream.js";
import { isPromptTooLongError } from "../supervisor-enrich.js";
import { buildChatTools, listChatToolNames } from "./chat-tools.js";
import {
  buildGlobalChatPrompt,
  buildProjectChatPrompt,
} from "./lifecycle-context.js";
import {
  listEndpointModels,
  updateEndpointModel,
  type EndpointModelList,
} from "./models.js";
import type {
  ChatContextDeps,
  ChatEvent,
  ChatEventListener,
  ChatToolDispatch,
  ConversationStore,
  PendingAction,
} from "./types.js";

const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_TURN_TIMEOUT_MS = 240_000;
const MAX_STEPS = 16;

export interface ChatServiceDeps {
  store: ConversationStore;
  /** Lazy — the Memory instance comes from a Mastra runtime created on demand. */
  getMemory: () => Memory;
  dispatch: ChatToolDispatch;
  context: ChatContextDeps;
  /** Path to endpoints.json — re-read per turn so model edits apply live. */
  endpointsPath: string;
  confirmTimeoutMs?: number;
  turnTimeoutMs?: number;
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

  constructor(private readonly deps: ChatServiceDeps) {
    this.emitter.setMaxListeners(100);
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
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

  getConversation(id: string): ChatConversation {
    const conversation = this.deps.store.getConversation(id);
    if (!conversation) throw new ConversationNotFoundError(id);
    return conversation;
  }

  closeConversation(id: string): ChatConversation {
    const conversation = this.getConversation(id);
    const closed = this.deps.store.closeConversation(id) ?? conversation;
    this.emit(closed, { type: "closed" });
    return closed;
  }

  deleteConversation(id: string): boolean {
    return this.deps.store.deleteConversation(id);
  }

  /** Idle sweep: close active conversations past maxIdleMs. Returns closed. */
  closeIdleConversations(maxIdleMs: number, now: Date = new Date()): string[] {
    const closed: string[] = [];
    for (const c of this.deps.store.listConversations({ status: "active" })) {
      const idleMs = now.getTime() - Date.parse(c.lastActiveAt);
      if (idleMs < maxIdleMs) continue;
      this.deps.store.closeConversation(c.id);
      this.emit(c, { type: "closed", summary: "idle timeout" });
      closed.push(c.id);
    }
    return closed;
  }

  // ---- model management ----

  async listModels(): Promise<EndpointModelList[]> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    return Promise.all(
      registry.listEndpoints().map((endpoint) => listEndpointModels(endpoint)),
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
    return updateEndpointModel({
      endpointsPath: this.deps.endpointsPath,
      endpointId,
      modelId,
    });
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
   */
  async confirm(opts: {
    conversationId: string;
    token: string;
    approve: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    const conversation = this.getConversation(opts.conversationId);
    const action = this.getPendingAction(opts.token);
    if (!action || action.conversationId !== conversation.id) {
      return { ok: false, error: "Unknown or expired confirmation token" };
    }
    this.pending.delete(opts.token);

    if (!opts.approve) {
      this.emit(conversation, {
        type: "confirm_resolved",
        tool: action.tool,
        token: opts.token,
        approved: false,
      });
      await this.runSyntheticTurn(
        conversation,
        `[operator DENIED the ${action.tool} action — do not retry it unless they ask]`,
      );
      return { ok: true };
    }

    const result = await this.deps.dispatch(action.tool, action.args);
    const text = result.content.map((c) => c.text).join("\n").slice(0, 4_000);
    this.emit(conversation, {
      type: "confirm_resolved",
      tool: action.tool,
      token: opts.token,
      approved: true,
    });
    this.emit(conversation, {
      type: "tool_result",
      tool: action.tool,
      summary: result.isError ? `failed: ${text.slice(0, 200)}` : text.slice(0, 200),
    });
    await this.runSyntheticTurn(
      conversation,
      `[operator CONFIRMED ${action.tool}] Result (isError=${Boolean(result.isError)}):\n${text}`,
    );
    return { ok: !result.isError, error: result.isError ? text : undefined };
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

    const queue: ChatEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = this.subscribe((event) => {
      if (event.conversationId !== conversationId) return;
      queue.push(event);
      wake?.();
    });

    try {
      const turn = this.runTurn(conversation, text, { synthetic: false });
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
      unsubscribe();
    }
  }

  private async runTurn(
    conversation: ChatConversation,
    text: string,
    opts: { synthetic: boolean },
  ): Promise<void> {
    const registry = LlmRegistry.fromFile(this.deps.endpointsPath);
    const override = conversation.modelOverride;
    const model = override
      ? toMastraModelConfig(registry.getEndpoint(override.endpointId), override.modelId)
      : registry.resolve("chat");

    const systemPrompt = conversation.projectId
      ? buildProjectChatPrompt({
          project: this.deps.context.getProject(conversation.projectId)!,
          deps: this.deps.context,
        })
      : buildGlobalChatPrompt({ deps: this.deps.context });

    const tools = buildChatTools({
      dispatch: this.deps.dispatch,
      conversationId: conversation.id,
      projectId: conversation.projectId,
      requestConfirmation: (tool, args) =>
        this.requestConfirmation(conversation, tool, args),
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
      const trimmed = (finalText || reply).trim();
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
