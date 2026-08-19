import { execFile } from "node:child_process";
import {
  createAgentSession,
  ModelRuntime as PiModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import type { LlmEndpoint } from "@slopcontrol/types";
import type {
  CodingEvent,
  CodingResult,
  CodingSession,
  CodingSessionMode,
  CodingTool,
  CreateSessionOptions,
  RunPromptOptions,
} from "./index.js";
import {
  CodingSessionAckError,
  type CodingEventListener,
} from "./opencode-adapter.js";
import { detectCodingProbeAbuseFromEvents } from "./probe-abuse.js";
import { dirtyDelta, gitStatusPaths } from "./dirty-delta.js";
import {
  detectProviderRateLimit,
  TURN_BUDGET_YIELD,
} from "./provider-stall.js";

type TurnSignal = { kind: "idle" } | { kind: "error"; message: string };

interface PiSessionState {
  agent: AgentSession;
  modelRuntime: PiModelRuntime;
  projectDir: string;
  mode: CodingSessionMode;
  onEvent?: CodingEventListener;
  unsubscribe?: () => void;
  /** Rolling text from the tool/event stream for probe detection */
  recentEventText: string;
  /** Accumulated assistant text for the in-flight turn */
  turnText: string;
  lastActivityAt: number;
  turnWaiter?: { resolve: (signal: TurnSignal) => void } | null;
  /** True once the in-flight turn's first turn_start arrives — stale
   *  agent_end events from the previous turn must not resolve the waiter. */
  seenTurnStart: boolean;
  /** Context queued via injectContext; folded into the next real prompt */
  pendingContext: string[];
  /** Repo status captured at session creation; getChangedFiles reports only
   *  the delta attributable to this session (null when capture failed). */
  dirtyBaseline: Set<string> | null;
}

export const PI_INVESTIGATE_SYSTEM_PROMPT = `You are a read-only codebase investigator for SlopControl Ask.
Walk the project like a code reviewer. Reconstruct what a named page/route shows from source (the route module and its imported sections). Then verify comparison targets the operator named.

Rules:
- Do NOT write, edit, create, or delete files. Do NOT commit. Do NOT print secrets or .env values.
- Do NOT treat BLUEPRINT.md Live decisions as evidence of what a page shows.
- Cite concrete paths you read. Return markdown findings the Ask judge can use.`;

export const VERIFY_RECOVER_SYSTEM_PROMPT = `You are SlopControl's verify harness recovery investigator.

You recover verify failures (deps install, cache corruption, compose/port collisions) — NOT product source bugs.

Rules:
- Working directory is the verify cwd SlopControl provides.
- Investigate first with bash probes only: ls, stat, test, du, df, npm/pnpm/yarn read-only subcommands (config get, doctor, why), docker ps, lsof.
- Do NOT mutate the tree during investigation (no rm, install, ci, clean, compose up/down).
- Do NOT edit application source under src/, app/, etc.
- Do NOT re-run the exact failing verify command blindly — diagnose, then propose one fix command.
- When ready, end with ONLY a JSON object:
{"execute":"<bash command or short && chain>","rationale":"<what you found>","confidence":"high|medium|low"}`;

export function piAckPrompt(mode: CodingSessionMode = "implement"): string {
  if (mode === "investigate") {
    return "Acknowledge you are ready to inspect the codebase. Do not change files.";
  }
  if (mode === "recover") {
    return "Acknowledge you are ready to investigate the verify harness failure. Probe only — do not mutate files yet.";
  }
  return "Acknowledge you are ready to implement. Do not change files yet.";
}

export function piSessionPreamble(
  projectDir: string,
  mode: CodingSessionMode,
  endpoint?: LlmEndpoint,
  modelId?: string,
): string {
  const driven =
    mode === "investigate"
      ? "You are being driven by SlopControl Ask. Investigate the codebase only. Do not change files, commit, or print secrets."
      : mode === "recover"
        ? "You are being driven by SlopControl verify recovery. Probe the harness failure; emit RECOVERY_EXECUTE JSON when ready. Do not mutate files during investigation."
        : "You are being driven by SlopControl. Follow PHASE.md / APPENDIX.md. Do not curl APIs with secrets.";
  return [
    `Working directory: ${projectDir}`,
    endpoint
      ? `Preferred model endpoint: ${endpoint.baseUrl} (${endpoint.apiType}) model=${modelId ?? endpoint.modelId}`
      : null,
    driven,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Operator-facing note when the investigate walker dirtied the tree. */
export function formatInvestigateDirtyTree(changed: string[]): string | null {
  const files = changed.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) return null;
  const listed = files.slice(0, 20).join(", ");
  const extra = files.length > 20 ? ` (+${files.length - 20} more)` : "";
  return `Investigation walker modified files (must not happen): ${listed}${extra}. Treat findings as untrusted.`;
}

const sessions = new Map<string, PiSessionState>();

const DEFAULT_TURN_TIMEOUT_MS = Number(
  process.env.SLOPCONTROL_CODING_TURN_MS ?? 600_000,
);

const DEFAULT_IDLE_MS = Number(
  process.env.SLOPCONTROL_CODING_IDLE_MS ?? 90_000,
);

const DEFAULT_ACK_TIMEOUT_MS = Number(
  process.env.SLOPCONTROL_ACK_TURN_MS ?? 120_000,
);

/** Providers pi knows natively for auth/catalog resolution. */
const KNOWN_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "mistral",
  "groq",
  "xai",
  "deepseek",
  "openrouter",
  "ollama",
  "azure",
  "bedrock",
]);

const LOCAL_BASE_RE = /localhost|127\.0\.0\.1|host\.docker\.internal/i;

/** SlopControl apiType -> pi wire api. */
export function piApiTypeFor(apiType?: string): string {
  return apiType === "anthropic-messages"
    ? "anthropic-messages"
    : "openai-completions";
}

function isLocalOllama(endpoint?: LlmEndpoint): boolean {
  const base = endpoint?.baseUrl ?? "";
  return /:11434/i.test(base);
}

/**
 * Map an LlmEndpoint (+ modelId) into a pi `Model` object. Pure — the
 * resolver never consults pi's network catalog.
 *
 * Provider attribution matters for one thing: where the runtime api key is
 * attached. A `provider/model`-prefixed id naming a KNOWN provider wins;
 * otherwise we fall back to URL/apiType heuristics ("anthropic" in the URL
 * or an anthropic-messages apiType -> anthropic, else openai).
 */
export function piModelFor(
  endpoint?: LlmEndpoint,
  modelId?: string,
): Model<string> | undefined {
  const rawId = modelId ?? endpoint?.modelId;
  if (!rawId) return undefined;

  const reasoning = /^(o1|o3)/i.test(rawId) || /reasoning/i.test(rawId);

  if (isLocalOllama(endpoint)) {
    const id = rawId.replace(/^ollama\//i, "");
    return {
      id,
      name: id,
      api: "openai-completions",
      provider: "ollama",
      baseUrl: endpoint?.baseUrl ?? "http://localhost:11434/v1",
      reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 8192,
    } as Model<string>;
  }

  let provider: string | undefined;
  let id = rawId;
  const slash = rawId.indexOf("/");
  if (slash > 0) {
    const prefix = rawId.slice(0, slash);
    if (KNOWN_PROVIDERS.has(prefix)) {
      provider = prefix;
      id = rawId.slice(slash + 1);
    }
  }
  if (!provider) {
    provider =
      endpoint?.apiType === "anthropic-messages" ||
      (endpoint?.baseUrl ? /anthropic/i.test(endpoint.baseUrl) : false)
        ? "anthropic"
        : "openai";
  }

  return {
    id,
    name: rawId,
    api: piApiTypeFor(endpoint?.apiType),
    provider,
    baseUrl: endpoint?.baseUrl ?? "",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    // Custom-baseUrl models bypass pi's catalog auth lookup, so attach the
    // credential at the transport layer explicitly (runtime api key is also
    // set for catalog-known providers in createSession).
    headers: {
      ...(endpoint?.headers ?? {}),
      ...(endpoint?.apiKey
        ? { Authorization: `Bearer ${endpoint.apiKey}` }
        : {}),
    },
  } as Model<string>;
}

function appendEventText(state: PiSessionState, payload: unknown): void {
  try {
    const chunk = JSON.stringify(payload);
    state.recentEventText = (state.recentEventText + "\n" + chunk).slice(
      -20_000,
    );
    state.lastActivityAt = Date.now();
  } catch {
    // ignore
  }
}

async function abortAgent(state: PiSessionState): Promise<void> {
  await state.agent.abort().catch(() => undefined);
}

async function worktreeHasChanges(projectDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "-uall"],
      { cwd: projectDir },
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        resolve(stdout.trim().length > 0);
      },
    );
  });
}

/**
 * Dispatch `session.prompt(text)` (non-blocking — pi runs the loop in the
 * background) and drive completion from the session event subscription.
 * Same watchdog contract as the OpenCode adapter: probe-abuse, provider
 * rate-limit, event silence, wall-clock budget with soft yield.
 */
function runTurnEventDriven(
  state: PiSessionState,
  text: string,
  timeoutMs: number,
  idleMs: number,
): Promise<CodingResult> {
  state.recentEventText = "";
  state.turnText = "";
  state.lastActivityAt = Date.now();
  state.seenTurnStart = false;

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
    const output = state.turnText.trim();
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

  const dispatch = (async () => {
    try {
      // A previous turn (e.g. the session ack) may still be flushing its
      // final events — pi rejects prompt() while streaming. Wait it out.
      if (state.agent.isStreaming) {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (!state.agent.isStreaming || settled) {
              resolve();
              return;
            }
            setTimeout(check, 100);
          };
          check();
        });
      }
      if (settled) return superseded();
      await state.agent.prompt(text);
      // Dispatched — completion arrives via the event subscription.
      return new Promise<CodingResult>(() => undefined);
    } catch (error) {
      return finish({
        output: `Pi prompt dispatch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        exitCode: 1,
        aborted: true,
        abortReason: "prompt_dispatch_failed",
        events: [],
      });
    }
  })();

  const watchdog = new Promise<CodingResult>((resolve) => {
    const started = Date.now();
    watchdogTimer = setInterval(() => {
      if (settled) {
        clearInterval(watchdogTimer);
        return;
      }

      const probe = detectCodingProbeAbuseFromEvents(state.recentEventText);
      if (probe) {
        void abortAgent(state);
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
        void abortAgent(state);
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
        void abortAgent(state);
        resolve(
          finish({
            output: `Coding turn idle: no pi events for ${idleMs}ms. Coding LLM may be stalled or throttled.`,
            exitCode: 1,
            aborted: true,
            abortReason: "turn_idle",
            events: [],
          }),
        );
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        void abortAgent(state);
        void (async () => {
          const changed = await worktreeHasChanges(state.projectDir);
          resolve(
            finish(
              changed
                ? {
                    output:
                      `Coding turn soft budget (${timeoutMs}ms) reached with worktree changes. ` +
                      `Yielding; pi session stays sticky — continue next iteration without recreate.`,
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

export class PiAdapter implements CodingTool {
  readonly id = "pi";

  async createSession(opts: CreateSessionOptions): Promise<CodingSession> {
    const mode: CodingSessionMode =
      opts.mode === "investigate"
        ? "investigate"
        : opts.mode === "recover"
          ? "recover"
          : "implement";
    const model = piModelFor(opts.endpoint, opts.modelId);
    if (!model) {
      throw new Error(
        "Pi coding agent requires a model: set the project coding endpoint (project_set_coding_endpoint) or pass modelId.",
      );
    }

    // Explicit endpoint key -> isolated in-memory credentials (nothing reads
    // or writes ~/.pi). No key configured -> pi's default file-backed auth
    // store (~/.pi/agent/auth.json) so `pi auth login` credentials work.
    const credentials = opts.endpoint?.apiKey
      ? new InMemoryCredentialStore()
      : undefined;
    const modelRuntime = await PiModelRuntime.create({
      ...(credentials ? { credentials } : {}),
      allowModelNetwork: false,
    });
    if (opts.endpoint?.apiKey) {
      await modelRuntime.setRuntimeApiKey(model.provider, opts.endpoint.apiKey);
    }

    const { session: agent } = await createAgentSession({
      cwd: opts.projectDir,
      model,
      modelRuntime,
      sessionManager: SessionManager.inMemory(opts.projectDir),
      settingsManager: SettingsManager.inMemory(),
    });

    const codingSession: CodingSession = {
      id: `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectDir: opts.projectDir,
      toolId: this.id,
    };

    // Baseline before any turn runs so getChangedFiles can attribute only
    // this session's mutations (post-merge verify trees are already dirty).
    const dirtyBaseline = new Set(await gitStatusPaths(opts.projectDir));

    const state: PiSessionState = {
      agent,
      modelRuntime,
      projectDir: opts.projectDir,
      mode,
      onEvent: opts.onEvent,
      recentEventText: "",
      turnText: "",
      lastActivityAt: Date.now(),
      seenTurnStart: false,
      pendingContext: [],
      dirtyBaseline,
    };

    sessions.set(codingSession.id, state);
    // Subscribe before the ack turn so its completion event cannot be missed.
    this.subscribe(state);

    const ack = await runTurnEventDriven(
      state,
      `${piSessionPreamble(opts.projectDir, mode, opts.endpoint, opts.modelId)}\n\n${piAckPrompt(mode)}`,
      DEFAULT_ACK_TIMEOUT_MS,
      DEFAULT_IDLE_MS,
    );
    if (ack.aborted) {
      state.unsubscribe?.();
      state.agent.dispose();
      sessions.delete(codingSession.id);
      throw new CodingSessionAckError("pi", ack.abortReason ?? "unknown");
    }

    return codingSession;
  }

  async injectContext(
    session: CodingSession,
    label: string,
    content: string,
  ): Promise<void> {
    const state = sessions.get(session.id);
    if (!state) {
      throw new Error(`Unknown pi session: ${session.id}`);
    }
    if (!content.trim()) return;
    // No freebie transcript append in pi — queue it and prepend to the next
    // real prompt, so context never burns an extra model turn.
    state.pendingContext.push(`[Context: ${label}]\n\n${content}`);
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
      throw new Error(`Unknown pi session: ${session.id}`);
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const idleMs = Number(
      process.env.SLOPCONTROL_CODING_IDLE_MS ?? DEFAULT_IDLE_MS,
    );

    const parts = [...state.pendingContext];
    state.pendingContext = [];
    if (state.mode === "investigate") {
      parts.unshift(PI_INVESTIGATE_SYSTEM_PROMPT);
    } else if (state.mode === "recover") {
      parts.unshift(VERIFY_RECOVER_SYSTEM_PROMPT);
    }
    if (system) parts.unshift(system);
    const text = parts.length > 0 ? `${parts.join("\n\n")}\n\n${prompt}` : prompt;

    return runTurnEventDriven(state, text, timeoutMs, idleMs);
  }

  async getChangedFiles(session: CodingSession): Promise<string[]> {
    const state = sessions.get(session.id);
    if (!state) return [];
    return dirtyDelta(state.dirtyBaseline, await gitStatusPaths(state.projectDir));
  }

  async abort(session: CodingSession): Promise<void> {
    const state = sessions.get(session.id);
    if (!state) return;

    state.unsubscribe?.();
    state.turnWaiter?.resolve({
      kind: "error",
      message: "Session aborted by SlopControl",
    });
    state.turnWaiter = null;
    await state.agent.abort().catch(() => undefined);
    state.agent.dispose();
    sessions.delete(session.id);
  }

  private subscribe(state: PiSessionState): void {
    state.unsubscribe = state.agent.subscribe((event: AgentSessionEvent) => {
      state.lastActivityAt = Date.now();
      appendEventText(state, event);

      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent;
        if (
          (delta.type === "text_delta" || delta.type === "thinking_delta") &&
          typeof delta.delta === "string"
        ) {
          state.turnText += delta.delta;
        } else if (delta.type === "error") {
          const err = (delta as { error?: unknown }).error;
          state.turnWaiter?.resolve({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : typeof err === "string"
                  ? err
                  : "Pi agent stream error",
          });
        }
      } else if (event.type === "turn_start") {
        state.seenTurnStart = true;
      } else if (event.type === "turn_end") {
        // Provider/transport failures surface as stopReason "error" with an
        // empty assistant message — treat as a turn failure, not success.
        const msg = event.message as {
          stopReason?: string;
          errorMessage?: string;
        };
        if (msg.stopReason === "error") {
          state.turnWaiter?.resolve({
            kind: "error",
            message: `Pi turn failed: ${msg.errorMessage ?? "provider error"}`,
          });
        }
      } else if (event.type === "agent_end") {
        // Only settle when this turn actually started — the ack turn's
        // trailing agent_end can land inside the next turn's waiter window.
        if (state.seenTurnStart) {
          state.turnWaiter?.resolve({ kind: "idle" });
        }
      }

      state.onEvent?.({ type: event.type, payload: event });
    });
  }
}
