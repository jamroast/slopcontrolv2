import type { LlmEndpoint } from "@slopcontrol/types";
import type { CodingEventListener } from "./opencode-adapter.js";

export interface CodingSession {
  id: string;
  projectDir: string;
  toolId: string;
}

export interface CodingEvent {
  type: string;
  payload: unknown;
}

export interface CodingResult {
  output: string;
  exitCode: number;
  structuredOutput?: unknown;
  events?: CodingEvent[];
  /** True when the turn was aborted for probe abuse or wall-clock timeout */
  aborted?: boolean;
  abortReason?: string;
}

export type CodingSessionMode = "implement" | "investigate";

export interface CreateSessionOptions {
  projectDir: string;
  endpoint?: LlmEndpoint;
  modelId?: string;
  onEvent?: CodingEventListener;
  /**
   * implement (default): development worktree sessions.
   * investigate: read-only Ask walker — do not change files.
   */
  mode?: CodingSessionMode;
}

export interface RunPromptOptions {
  /** Max wall-clock ms for a single coding turn (default 240000) */
  timeoutMs?: number;
}

export interface CodingTool {
  id: string;
  createSession(opts: CreateSessionOptions): Promise<CodingSession>;
  runPrompt(session: CodingSession, prompt: string, opts?: RunPromptOptions): Promise<CodingResult>;
  runPromptWithSystem?(
    session: CodingSession,
    prompt: string,
    system?: string,
    opts?: RunPromptOptions,
  ): Promise<CodingResult>;
  injectContext?(
    session: CodingSession,
    label: string,
    content: string,
  ): Promise<void>;
  getChangedFiles(session: CodingSession): Promise<string[]>;
  abort(session: CodingSession): Promise<void>;
}

export interface CodingToolFactoryOptions {
  opencodePort?: number;
}

export type CodingToolFactory = (opts?: CodingToolFactoryOptions) => CodingTool;

export * from "./opencode-adapter.js";
export * from "./pi-adapter.js";
export * from "./probe-abuse.js";
export * from "./provider-stall.js";
export * from "./ensure-opencode.js";
export * from "./git-worktree.js";
export * from "./design-tool.js";
export * from "./design-media.js";
export * from "./design-image-edit.js";
export * from "./design-image-catalog.js";
export * from "./mock-screenshot.js";

export * from "./design-loop-review.js";
export * from "./registry.js";
export * from "./coding-engine-supervisor.js";
