import type {
  AskSession,
  AwaitedLiveTurn,
  AwaitedRun,
  ChatConversation,
  Phase,
  Project,
  Run,
} from "@slopcontrol/types";

/** Kind of run the chat is waiting on — drives differentiated wait timeouts. */
export type RunWaitKind = AwaitedRun["kind"];

export type { AwaitedRun, AwaitedLiveTurn };

/** Events emitted on a conversation stream (per-chat + aggregate SSE). */
export interface ChatEvent {
  conversationId: string;
  /** null for global-scope conversations. */
  projectId: string | null;
  type:
    | "delta"
    | "tool_call"
    | "tool_result"
    | "confirm_request"
    | "confirm_resolved"
    | "status"
    | "done"
    | "error"
    | "closed"
    | "run_awaited"
    | "run_progress"
    | "run_settled"
    | "live_awaited"
    | "live_progress"
    | "live_settled";
  at: string;
  /** delta text / done reply. */
  text?: string;
  /** tool_call / tool_result / confirm_request tool name. */
  tool?: string;
  /** Human one-liner for tool_call/tool_result/status. */
  summary?: string;
  /** confirm_request token (approve/deny via confirm()). */
  token?: string;
  /** confirm_request sanitized args preview. */
  argsPreview?: string;
  /** confirm_resolved outcome. */
  approved?: boolean;
  /** error message. */
  error?: string;
  /** run_awaited / run_settled / run_progress payload. */
  run?: {
    runId: string;
    projectId?: string;
    stage?: string;
    kind?: RunWaitKind;
    elapsedMs?: number;
    timedOut?: boolean;
    error?: string;
  };
  /** live_awaited / live_progress / live_settled payload. */
  live?: {
    turnId?: string;
    kind?: AwaitedLiveTurn["kind"];
    sessionId?: string;
    projectId?: string;
    status?: string;
    elapsedMs?: number;
    isError?: boolean;
  };
}

export type ChatEventListener = (event: ChatEvent) => void;

/** User-facing transcript row (GET /chats/:id). Tool-call parts are dropped. */
export interface ChatTranscriptMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

/** Structural interface satisfied by SlopStore (apps/server). */
export interface ConversationStore {
  listConversations(opts?: {
    projectId?: string | null;
    status?: ChatConversation["status"];
  }): ChatConversation[];
  getConversation(id: string): ChatConversation | undefined;
  createConversation(input: {
    projectId: string | null;
    title?: string;
    modelOverride?: ChatConversation["modelOverride"];
  }): ChatConversation;
  updateConversation(conversation: ChatConversation): void;
  touchConversation(
    id: string,
    titleHint?: string,
  ): ChatConversation | undefined;
  closeConversation(id: string): ChatConversation | undefined;
  deleteConversation(id: string): boolean;
  /** Persist or clear the run this conversation is awaiting. */
  setAwaitedRun?(
    conversationId: string,
    awaited: AwaitedRun | null,
  ): void;
  setAwaitedLiveTurn?(
    conversationId: string,
    awaited: AwaitedLiveTurn | null,
  ): void;
}

/** Matches the MCP tool result envelope (dispatchSlopcontrolTool). */
export interface ChatToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

export type ChatToolDispatch = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ChatToolResult>;

/** Live project state injected into the chat agent's system prompt. */
export interface ChatContextDeps {
  listProjects(): Project[];
  listPhases(projectId: string): Phase[];
  listRuns(projectId?: string): Run[];
  getProject(id: string): Project | undefined;
  /** Optional — used to see if a chat ask latch is still open. */
  getAsk?(id: string): Pick<AskSession, "id" | "status" | "title"> | undefined;
}

export interface PendingAction {
  token: string;
  conversationId: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}
