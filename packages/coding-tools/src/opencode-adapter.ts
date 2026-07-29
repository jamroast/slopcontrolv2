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
import { ensureOpenCodeFetchTimeouts } from "./opencode-fetch.js";
import { detectCodingProbeAbuseFromEvents } from "./probe-abuse.js";
import {
  detectProviderRateLimit,
  TURN_BUDGET_YIELD,
} from "./provider-stall.js";

export type CodingEventListener = (event: CodingEvent) => void;

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
        throw new Error(
          `${label} failed after ${i} attempt(s): ${message}. ` +
            `If this is "fetch failed", OpenCode may have dropped a long-running prompt — ` +
            `avoid live API probing loops; keep coding turns focused.`,
        );
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

/**
 * Race a blocking OpenCode prompt against probe / rate-limit / idle / wall-clock watchdogs.
 * Wall-clock with file changes → turn_budget_yield (sticky session).
 */
function runPromptWithWatchdog(
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

  const shouldAbort = () => settled;

  const promptPromise = withFetchRetry(
    "OpenCode session.prompt",
    () =>
      state.client.session.prompt({
        path: { id: state.sessionId },
        query: { directory: state.projectDir },
        body: {
          ...(body.system ? { system: body.system } : {}),
          ...(state.model ? { model: state.model } : {}),
          parts: body.parts,
        },
      }),
    { shouldAbort },
  )
    .then((result) => {
      if (settled) {
        return {
          output: "",
          exitCode: 1,
          aborted: true,
          abortReason: "superseded_by_watchdog",
          events: [],
        } satisfies CodingResult;
      }
      settled = true;
      if (watchdogTimer) clearInterval(watchdogTimer);
      const parts = result.data?.parts ?? [];
      const output = extractTextOutput(
        parts as Array<{ type?: string; text?: string }>,
      );
      const probe = detectCodingProbeAbuseFromEvents(state.recentEventText);
      if (probe) {
        return {
          output: `${output}\n\n${probe}`,
          exitCode: 1,
          aborted: true,
          abortReason: probe,
          events: [],
        } satisfies CodingResult;
      }
      const rate = detectProviderRateLimit(state.recentEventText);
      if (rate) {
        return {
          output: `${output}\n\n${rate}`,
          exitCode: 1,
          aborted: true,
          abortReason: "provider_rate_limit",
          events: [],
        } satisfies CodingResult;
      }
      return {
        output,
        exitCode: output.includes("DEV_BLOCKED") ? 1 : 0,
        events: [],
      } satisfies CodingResult;
    })
    .catch((error) => {
      if (settled) {
        return {
          output: "",
          exitCode: 1,
          aborted: true,
          abortReason: "superseded_by_watchdog",
          events: [],
        } satisfies CodingResult;
      }
      throw error;
    });

  const watchdog = new Promise<CodingResult>((resolve) => {
    const started = Date.now();
    watchdogTimer = setInterval(() => {
      if (settled) {
        clearInterval(watchdogTimer);
        return;
      }

      const probe = detectCodingProbeAbuseFromEvents(state.recentEventText);
      if (probe) {
        settled = true;
        clearInterval(watchdogTimer);
        abortSession(state);
        resolve({
          output: probe,
          exitCode: 1,
          aborted: true,
          abortReason: probe,
          events: [],
        });
        return;
      }

      const rate = detectProviderRateLimit(state.recentEventText);
      if (rate) {
        settled = true;
        clearInterval(watchdogTimer);
        abortSession(state);
        resolve({
          output: rate,
          exitCode: 1,
          aborted: true,
          abortReason: "provider_rate_limit",
          events: [],
        });
        return;
      }

      const silentMs = Date.now() - state.lastActivityAt;
      if (silentMs >= idleMs && Date.now() - started >= idleMs) {
        settled = true;
        clearInterval(watchdogTimer);
        abortSession(state);
        resolve({
          output: `Coding turn idle: no OpenCode events for ${idleMs}ms. Coding LLM may be stalled or throttled.`,
          exitCode: 1,
          aborted: true,
          abortReason: "turn_idle",
          events: [],
        });
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        settled = true;
        clearInterval(watchdogTimer);
        abortSession(state);
        void (async () => {
          const changed = await sessionHasFileChanges(state);
          if (changed) {
            resolve({
              output:
                `Coding turn soft budget (${timeoutMs}ms) reached with worktree changes. ` +
                `Yielding; OpenCode session stays sticky — continue next iteration without recreate.`,
              exitCode: 1,
              aborted: true,
              abortReason: TURN_BUDGET_YIELD,
              events: [],
            });
          } else {
            resolve({
              output: `Coding turn exceeded ${timeoutMs}ms wall clock with no file changes. Aborting; coding LLM may be stalled.`,
              exitCode: 1,
              aborted: true,
              abortReason: "turn_timeout",
              events: [],
            });
          }
        })();
      }
    }, 2000);
  });

  return Promise.race([promptPromise, watchdog]);
}

function createClient(baseUrl: string) {
  ensureOpenCodeFetchTimeouts();
  // Use default globalThis.fetch (Request-compatible). Long timeouts come from
  // setGlobalDispatcher — do not pass a custom undici fetch wrapper.
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
    void this.startEventStream(state);

    const contextParts = [
      `Working directory: ${opts.projectDir}`,
      opts.endpoint
        ? `Preferred model endpoint: ${opts.endpoint.baseUrl} (${opts.endpoint.apiType}) model=${opts.modelId ?? opts.endpoint.modelId}`
        : null,
      "You are being driven by SlopControl. Follow PHASE.md / APPENDIX.md. Do not curl APIs with secrets.",
    ]
      .filter(Boolean)
      .join("\n");

    const ack = await runPromptWithWatchdog(
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

    const result = await runPromptWithWatchdog(
      state,
      {
        system: `${label}\n\n${content}`,
        parts: [
          {
            type: "text",
            text: `Context updated: ${label}. Wait for the next implementation instruction.`,
          },
        ],
      },
      DEFAULT_TURN_TIMEOUT_MS,
      DEFAULT_IDLE_MS,
    );
    if (result.aborted) {
      throw new Error(
        `OpenCode injectContext aborted: ${result.abortReason ?? "unknown"}`,
      );
    }
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

    return runPromptWithWatchdog(
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
    await state.client.session
      .abort({
        path: { id: state.sessionId },
        query: { directory: state.projectDir },
      })
      .catch(() => undefined);
    sessions.delete(session.id);
  }

  private async startEventStream(state: OpenCodeSessionState): Promise<void> {
    const abort = new AbortController();
    state.eventAbort = abort;

    try {
      const events = await state.client.event.subscribe({
        query: { directory: state.projectDir },
      });

      for await (const event of events.stream) {
        if (abort.signal.aborted) break;
        appendEventText(state, event);
        state.onEvent?.({
          type: String((event as { type?: string }).type ?? "event"),
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
  }
}

export {
  detectCodingProbeAbuse,
  detectCodingProbeAbuseFromEvents,
  extractBashCommandsFromEvents,
} from "./probe-abuse.js";
