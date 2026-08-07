import { createOpencodeClient } from "@opencode-ai/sdk";
import type { LlmEndpoint } from "@slopcontrol/types";
import { ensureOpenCodeRunning } from "./ensure-opencode.js";
import type {
  CodingEvent,
  CodingResult,
  CodingSession,
  CodingTool,
  RunPromptOptions,
} from "./index.js";
import { detectCodingProbeAbuseFromEvents } from "./probe-abuse.js";
import {
  detectProviderRateLimit,
  TURN_BUDGET_YIELD,
} from "./provider-stall.js";

export type CodingEventListener = (event: CodingEvent) => void;

/** Turn completion signalled from the SSE event stream. */
type TurnSignal = { kind: "idle" } | { kind: "error"; message: string };

interface OpenCodeSessionState {
  client: ReturnType<typeof createOpencodeClient>;
  sessionId: string;
  projectDir: string;
  model?: { providerID: string; modelID: string };
  endpoint?: LlmEndpoint;
  onEvent?: CodingEventListener;
  eventAbort?: AbortController;
  /** Rolling text from tool/event stream for probe detection */
  recentEventText: string;
  /** Last OpenCode event timestamp (ms) for idle detection */
  lastActivityAt: number;
  /** Set while a promptAsync turn is in flight; resolved by session events */
  turnWaiter?: { resolve: (signal: TurnSignal) => void } | null;
}

const sessions = new Map<string, OpenCodeSessionState>();

const DEFAULT_TURN_TIMEOUT_MS = Number(
  process.env.SLOPCONTROL_CODING_TURN_MS ?? 600_000,
);

const DEFAULT_IDLE_MS = Number(
  process.env.SLOPCONTROL_CODING_IDLE_MS ?? 90_000,
);

function extractTextOutput(parts: Array<{ type?: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
}

function stripCloudSuffix(modelId: string): string {
  return modelId.replace(/:cloud$/i, "");
}

function isOllamaCloudEndpoint(endpoint?: LlmEndpoint, modelId?: string): boolean {
  const base = endpoint?.baseUrl ?? "";
  const id = modelId ?? endpoint?.modelId ?? "";
  return (
    /ollama\.com|ollama\.cloud|api\.ollama/i.test(base) ||
    /^ollama-cloud\//i.test(id) ||
    /:cloud$/i.test(id)
  );
}

/**
 * Map an LlmEndpoint + modelId into OpenCode's providerID/modelID shape.
 */
export function toOpenCodeModel(
  endpoint?: LlmEndpoint,
  modelId?: string,
): { providerID: string; modelID: string } | undefined {
  const id = modelId ?? endpoint?.modelId;
  if (!id) return undefined;

  if (id.includes("/")) {
    const [providerID, ...rest] = id.split("/");
    const modelID = stripCloudSuffix(rest.join("/"));
    if (providerID && modelID) {
      return { providerID, modelID };
    }
  }

  if (isOllamaCloudEndpoint(endpoint, id)) {
    return {
      providerID: "ollama-cloud",
      modelID: stripCloudSuffix(id),
    };
  }

  if (/localhost:11434|127\.0\.0\.1:11434/i.test(endpoint?.baseUrl ?? "")) {
    return { providerID: "ollama", modelID: id };
  }

  const providerID =
    endpoint?.apiType === "anthropic-messages" ? "anthropic" : "openai";
  return { providerID, modelID: id };
}

function isTransientFetchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|HeadersTimeoutError|headers timeout/i.test(
    message,
  );
}

async function withFetchRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { attempts?: number; shouldAbort?: () => boolean },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    if (opts?.shouldAbort?.()) {
      throw new Error(`${label} aborted before attempt ${i}`);
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (opts?.shouldAbort?.()) {
        throw new Error(
          `${label} aborted after failure: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isTransientFetchError(error) || i === attempts) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} failed after ${i} attempt(s): ${message}`);
      }
      const delayMs = 1500 * i;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function appendEventText(state: OpenCodeSessionState, payload: unknown): void {
  try {
    const chunk = JSON.stringify(payload);
    state.recentEventText = (state.recentEventText + "\n" + chunk).slice(-20_000);
    state.lastActivityAt = Date.now();
  } catch {
    // ignore
  }
}

/** Human-readable message from a session.error event payload. */
function describeSessionError(error: unknown): string {
  if (!error || typeof error !== "object") return "OpenCode session error";
  const record = error as {
    name?: string;
    message?: string;
    data?: { message?: string };
  };
  return (
    record.data?.message ??
    record.message ??
    record.name ??
    "OpenCode session error"
  );
}

function abortSession(state: OpenCodeSessionState): void {
  void state.client.session
    .abort({
      path: { id: state.sessionId },
      query: { directory: state.projectDir },
    })
    .catch(() => undefined);
}

async function sessionHasFileChanges(state: OpenCodeSessionState): Promise<boolean> {
  try {
    const status = await state.client.file.status({
      query: { directory: state.projectDir },
    });
    const files = status.data ?? [];
    return files.some((f) => Boolean(f.path));
  } catch {
    // If we cannot check, prefer soft yield (sticky) when events were active
    return Date.now() - state.lastActivityAt < 60_000;
  }
}

/** Read the most recent assistant message text after a turn goes idle. */
async function readLastAssistantText(
  state: OpenCodeSessionState,
): Promise<string> {
  try {
    const res = await state.client.session.messages({
      path: { id: state.sessionId },
      query: { directory: state.projectDir },
    });
    const messages = res.data ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message) continue;
      if ((message.info as { role?: string }).role === "assistant") {
        return extractTextOutput(
          message.parts as Array<{ type?: string; text?: string }>,
        );
      }
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Fire a non-blocking promptAsync and drive completion from the SSE event
 * stream (session.idle / session.error). Watchdogs: probe-abuse, provider
 * rate-limit, event-stream silence, wall-clock budget (soft yield with
 * worktree changes -> TURN_BUDGET_YIELD, sticky session).
 */
function runTurnEventDriven(
  state: OpenCodeSessionState,
  body: {
    system?: string;
    parts: Array<{ type: "text"; text: string }>;
  },
  timeoutMs: number,
  idleMs: number,
): Promise<CodingResult> {
  state.recentEventText = "";
  state.lastActivityAt = Date.now();

  let settled = false;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;

  const finish = (result: CodingResult): CodingResult => {
    if (!settled) {
      settled = true;
      if (watchdogTimer) clearInterval(watchdogTimer);
      state.turnWaiter = null;
    }
    return result;
  };

  const superseded = (): CodingResult => ({
    output: "",
    exitCode: 1,
    aborted: true,
    abortReason: "superseded_by_watchdog",
    events: [],
  });

  const turnSignal = new Promise<TurnSignal>((resolve) => {
    state.turnWaiter = { resolve };
  });

  const signalResult = turnSignal.then(async (signal): Promise<CodingResult> => {
    if (settled) return superseded();
    if (signal.kind === "error") {
      return finish({
        output: signal.message,
        exitCode: 1,
        aborted: true,
        abortReason: "session_error",
        events: [],
      });
    }
    const output = await readLastAssistantText(state);
    if (settled) return superseded();
    const probe = detectCodingProbeAbuseFromEvents(state.recentEventText);
    if (probe) {
      return finish({
        output: `${output}\n\n${probe}`,
        exitCode: 1,
        aborted: true,
        abortReason: probe,
        events: [],
      });
    }
    const rate = detectProviderRateLimit(state.recentEventText);
    if (rate) {
      return finish({
        output: `${output}\n\n${rate}`,
        exitCode: 1,
        aborted: true,
        abortReason: "provider_rate_limit",
        events: [],
      });
    }
    return finish({
      output,
      exitCode: output.includes("DEV_BLOCKED") ? 1 : 0,
      events: [],
    });
  });

  const dispatch = withFetchRetry(
    "OpenCode session.promptAsync",
    () =>
      state.client.session.promptAsync({
        path: { id: state.sessionId },
        query: { directory: state.projectDir },
        body: {
          ...(body.system ? { system: body.system } : {}),
          ...(state.model ? { model: state.model } : {}),
          parts: body.parts,
        },
      }),
    { shouldAbort: () => settled },
  ).then(
    // Dispatched — turn completion now comes from the event stream/watchdog.
    () => new Promise<CodingResult>(() => undefined),
    (error: unknown) =>
      finish({
        output: `OpenCode prompt dispatch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        exitCode: 1,
        aborted: true,
        abortReason: "prompt_dispatch_failed",
        events: [],
      }),
  );

  const watchdog = new Promise<CodingResult>((resolve) => {
    const started = Date.now();
    watchdogTimer = setInterval(() => {
      if (settled) {
        clearInterval(watchdogTimer);
        return;
      }

      const probe = detectCodingProbeAbuseFromEvents(state.recentEventText);
      if (probe) {
        abortSession(state);
        resolve(
          finish({
            output: probe,
            exitCode: 1,
            aborted: true,
            abortReason: probe,
            events: [],
          }),
        );
        return;
      }

      const rate = detectProviderRateLimit(state.recentEventText);
      if (rate) {
        abortSession(state);
        resolve(
          finish({
            output: rate,
            exitCode: 1,
            aborted: true,
            abortReason: "provider_rate_limit",
            events: [],
          }),
        );
        return;
      }

      const silentMs = Date.now() - state.lastActivityAt;
      if (silentMs >= idleMs && Date.now() - started >= idleMs) {
        abortSession(state);
        resolve(
          finish({
            output: `Coding turn idle: no OpenCode events for ${idleMs}ms. Coding LLM may be stalled or throttled.`,
            exitCode: 1,
            aborted: true,
            abortReason: "turn_idle",
            events: [],
          }),
        );
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        abortSession(state);
        void (async () => {
          const changed = await sessionHasFileChanges(state);
          resolve(
            finish(
              changed
                ? {
                    output:
                      `Coding turn soft budget (${timeoutMs}ms) reached with worktree changes. ` +
                      `Yielding; OpenCode session stays sticky — continue next iteration without recreate.`,
                    exitCode: 1,
                    aborted: true,
                    abortReason: TURN_BUDGET_YIELD,
                    events: [],
                  }
                : {
                    output: `Coding turn exceeded ${timeoutMs}ms wall clock with no file changes. Aborting; coding LLM may be stalled.`,
                    exitCode: 1,
                    aborted: true,
                    abortReason: "turn_timeout",
                    events: [],
                  },
            ),
          );
        })();
      }
    }, 2000);
  });

  return Promise.race([signalResult, watchdog, dispatch]);
}

function createClient(baseUrl: string) {
  // All session traffic is short-lived (promptAsync returns 204 immediately),
  // so the default globalThis.fetch timeouts are sufficient.
  return createOpencodeClient({ baseUrl });
}

export class OpenCodeAdapter implements CodingTool {
  readonly id = "opencode";

  constructor(
    private readonly baseUrl = `http://127.0.0.1:${process.env.OPENCODE_PORT ?? 4096}`,
  ) {}

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async createSession(opts: {
    projectDir: string;
    endpoint?: LlmEndpoint;
    modelId?: string;
    onEvent?: CodingEventListener;
  }): Promise<CodingSession> {
    await ensureOpenCodeRunning(this.baseUrl);

    const client = createClient(this.baseUrl);
    const model = toOpenCodeModel(opts.endpoint, opts.modelId);

    let created;
    try {
      created = await withFetchRetry("OpenCode session.create", async () =>
        client.session.create({
          body: {
            title: `slopcontrol-${Date.now()}`,
          },
          query: {
            directory: opts.projectDir,
          },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let portHint = "4096";
      try {
        portHint = new URL(this.baseUrl).port || "4096";
      } catch {
        // keep default
      }
      const isRequestParse =
        /Failed to parse URL from \[object Request\]/i.test(message);
      throw new Error(
        `Failed to create OpenCode session at ${this.baseUrl}: ${message}. ` +
          (isRequestParse
            ? `This is an HTTP client bug (custom fetch rejected Request), not a missing OpenCode daemon. `
            : `Ensure OpenCode is reachable at ${this.baseUrl} (e.g. opencode serve --port ${portHint}) ` +
              `and Ollama Cloud is authenticated (opencode providers list). `),
      );
    }

    const sessionId = created.data?.id;
    if (!sessionId) {
      throw new Error("OpenCode failed to create session");
    }

    const session: CodingSession = {
      id: sessionId,
      projectDir: opts.projectDir,
      toolId: this.id,
    };

    const state: OpenCodeSessionState = {
      client,
      sessionId,
      projectDir: opts.projectDir,
      model,
      endpoint: opts.endpoint,
      onEvent: opts.onEvent,
      recentEventText: "",
      lastActivityAt: Date.now(),
    };

    sessions.set(session.id, state);
    // Await the SSE subscription before the ack turn so the turn's
    // session.idle completion event cannot be missed.
    await this.startEventStream(state);

    const contextParts = [
      `Working directory: ${opts.projectDir}`,
      opts.endpoint
        ? `Preferred model endpoint: ${opts.endpoint.baseUrl} (${opts.endpoint.apiType}) model=${opts.modelId ?? opts.endpoint.modelId}`
        : null,
      "You are being driven by SlopControl. Follow PHASE.md / APPENDIX.md. Do not curl APIs with secrets.",
    ]
      .filter(Boolean)
      .join("\n");

    const ack = await runTurnEventDriven(
      state,
      {
        system: contextParts,
        parts: [
          {
            type: "text",
            text: "Acknowledge you are ready to implement. Do not change files yet.",
          },
        ],
      },
      DEFAULT_TURN_TIMEOUT_MS,
      DEFAULT_IDLE_MS,
    );
    if (ack.aborted) {
      state.eventAbort?.abort();
      sessions.delete(session.id);
      throw new Error(
        `OpenCode session ack aborted: ${ack.abortReason ?? "unknown"}`,
      );
    }

    return session;
  }

  async injectContext(
    session: CodingSession,
    label: string,
    content: string,
  ): Promise<void> {
    const state = sessions.get(session.id);
    if (!state) {
      throw new Error(`Unknown OpenCode session: ${session.id}`);
    }
    if (!content.trim()) return;

    // noReply: the context lands in the session transcript without burning a
    // model turn.
    await withFetchRetry("OpenCode injectContext", () =>
      state.client.session.prompt({
        path: { id: state.sessionId },
        query: { directory: state.projectDir },
        body: {
          noReply: true,
          parts: [
            { type: "text", text: `[Context: ${label}]\n\n${content}` },
          ],
        },
      }),
    );
  }

  async runPrompt(
    session: CodingSession,
    prompt: string,
    opts?: RunPromptOptions,
  ): Promise<CodingResult> {
    return this.runPromptWithSystem(session, prompt, undefined, opts);
  }

  async runPromptWithSystem(
    session: CodingSession,
    prompt: string,
    system?: string,
    opts?: RunPromptOptions,
  ): Promise<CodingResult> {
    const state = sessions.get(session.id);
    if (!state) {
      throw new Error(`Unknown OpenCode session: ${session.id}`);
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const idleMs = Number(
      process.env.SLOPCONTROL_CODING_IDLE_MS ?? DEFAULT_IDLE_MS,
    );

    return runTurnEventDriven(
      state,
      {
        ...(system ? { system } : {}),
        parts: [{ type: "text", text: prompt }],
      },
      timeoutMs,
      idleMs,
    );
  }

  async getChangedFiles(session: CodingSession): Promise<string[]> {
    const state = sessions.get(session.id);
    if (!state) return [];

    const status = await state.client.file.status({
      query: { directory: state.projectDir },
    });
    const files = status.data ?? [];
    return files
      .map((file) => file.path)
      .filter((path): path is string => Boolean(path));
  }

  async abort(session: CodingSession): Promise<void> {
    const state = sessions.get(session.id);
    if (!state) return;

    state.eventAbort?.abort();
    state.turnWaiter?.resolve({
      kind: "error",
      message: "Session aborted by SlopControl",
    });
    state.turnWaiter = null;
    await state.client.session
      .abort({
        path: { id: state.sessionId },
        query: { directory: state.projectDir },
      })
      .catch(() => undefined);
    sessions.delete(session.id);
  }

  /**
   * Subscribe to the directory event stream. Resolves once the subscription
   * is established so callers can safely fire promptAsync turns afterwards.
   */
  private async startEventStream(state: OpenCodeSessionState): Promise<void> {
    const abort = new AbortController();
    state.eventAbort = abort;

    let events: Awaited<ReturnType<typeof state.client.event.subscribe>>;
    try {
      events = await state.client.event.subscribe({
        query: { directory: state.projectDir },
      });
    } catch (error) {
      state.onEvent?.({
        type: "event.error",
        payload: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    void (async () => {
      try {
        for await (const event of events.stream) {
          if (abort.signal.aborted) break;
          appendEventText(state, event);
          if (
            event.type === "session.idle" &&
            event.properties.sessionID === state.sessionId
          ) {
            state.turnWaiter?.resolve({ kind: "idle" });
          } else if (
            event.type === "session.error" &&
            event.properties.sessionID === state.sessionId
          ) {
            state.turnWaiter?.resolve({
              kind: "error",
              message: describeSessionError(event.properties.error),
            });
          }
          state.onEvent?.({
            type: event.type,
            payload: event,
          });
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        state.onEvent?.({
          type: "event.error",
          payload: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();
  }
}

export {
  detectCodingProbeAbuse,
  detectCodingProbeAbuseFromEvents,
  extractBashCommandsFromEvents,
} from "./probe-abuse.js";
