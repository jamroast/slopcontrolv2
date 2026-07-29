import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectConfig } from "@slopcontrol/types";
import { loadDotEnvFile } from "./dotenv.js";
import { mergeEnvRecords, resolveProjectEnv } from "./project-env.js";

export type LlmTestProfile = "local" | "fixture" | "live";
export type LlmSmokeMode = "off" | "local" | "live";

const OVERLAY_KEYS = [
  "OLLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "AI_CHAT_MODEL",
  "AI_CODE_MODEL",
  "SLOPCONTROL_LLM_PROFILE",
] as const;

const LOCAL_DEFAULTS: Record<string, string> = {
  OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
  OLLAMA_API_KEY: "ollama",
  AI_CHAT_MODEL: "llama3.2",
  AI_CODE_MODEL: "llama3.2",
};

const FIXTURE_DEFAULTS: Record<string, string> = {
  OLLAMA_BASE_URL: "fixture://llm",
  OLLAMA_API_KEY: "fixture",
  AI_CHAT_MODEL: "fixture",
  AI_CODE_MODEL: "fixture",
};

export const ENV_TEST_EXAMPLE = `# SlopControl LLM test harness (committed template — no secrets)
# Copy to .env.test for local overrides, or set the same vars in CI/pipelines.
# Resolution order: process.env > .env.test > these defaults (when profile=local)

OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_API_KEY=ollama
AI_CHAT_MODEL=llama3.2
AI_CODE_MODEL=llama3.2
# SLOPCONTROL_LLM_PROFILE=local
`;

export const LLM_FIXTURE_HELPER = `/**
 * SlopControl LLM test client helper (scaffold).
 * When SLOPCONTROL_LLM_PROFILE=fixture (or OLLAMA_BASE_URL starts with fixture://),
 * return a deterministic fake client. Otherwise use the OpenAI-compat URL from env.
 */
export type LlmMessage = { role: string; content: string };

export function isFixtureLlmProfile(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const profile = (env.SLOPCONTROL_LLM_PROFILE ?? "").toLowerCase();
  const base = env.OLLAMA_BASE_URL ?? "";
  return profile === "fixture" || base.startsWith("fixture://");
}

export async function createTestLlmClient(opts?: {
  env?: NodeJS.ProcessEnv;
  fixturesDir?: string;
}) {
  const env = opts?.env ?? process.env;
  if (isFixtureLlmProfile(env)) {
    return {
      async chat(messages: LlmMessage[]) {
        const last = messages[messages.length - 1]?.content ?? "";
        return {
          model: env.AI_CHAT_MODEL ?? "fixture",
          content: \`fixture-ok:\${last.slice(0, 80)}\`,
        };
      },
    };
  }
  const base = (env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(
    /\\/$/,
    "",
  );
  const apiKey = env.OLLAMA_API_KEY ?? "ollama";
  const model = env.AI_CHAT_MODEL ?? "llama3.2";
  return {
    async chat(messages: LlmMessage[]) {
      const res = await fetch(\`\${base}/chat/completions\`, {
        method: "POST",
        headers: {
          Authorization: \`Bearer \${apiKey}\`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, messages, max_tokens: 64 }),
      });
      if (!res.ok) {
        throw new Error(\`LLM test client HTTP \${res.status}\`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return {
        model,
        content: json.choices?.[0]?.message?.content ?? "",
      };
    },
  };
}
`;

export type ResolvedLlmTestEnv = {
  profile: LlmTestProfile;
  /** Env overlay to inject into verify / test runners */
  env: Record<string, string>;
  source: string;
  notes: string[];
};

function pickProcessOverrides(
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OVERLAY_KEYS) {
    const v = processEnv[key]?.trim();
    if (v) out[key] = v;
  }
  return out;
}

function applyModelMap(
  env: Record<string, string>,
  map?: Record<string, string>,
): void {
  if (!map) return;
  for (const key of ["AI_CHAT_MODEL", "AI_CODE_MODEL"] as const) {
    const current = env[key]?.trim();
    if (current && map[current]) {
      env[key] = map[current];
    }
  }
}

function loadLiveDockerEnv(projectRoot: string): Record<string, string> {
  const docker = loadDotEnvFile(join(projectRoot, ".env.docker"));
  const local = loadDotEnvFile(join(projectRoot, ".env.local"));
  return Object.keys(docker).length > 0
    ? { ...local, ...docker }
    : { ...docker, ...local };
}

/**
 * Resolve LLM test env as a consumer of resolveProjectEnv.
 * process.env > project files > profile defaults. Never invents free-tier cloud URLs.
 */
export function resolveLlmTestEnv(opts: {
  projectRoot: string;
  config: Pick<
    ProjectConfig,
    | "llmTestProfile"
    | "llmTestEnvFile"
    | "llmModelMap"
    | "envMap"
    | "envPassthroughKeys"
    | "envPassthroughPrefixes"
    | "worktreeSyncPaths"
  >;
  processEnv?: NodeJS.ProcessEnv;
  /** Force profile (e.g. after probe fallback) */
  forceProfile?: LlmTestProfile;
}): ResolvedLlmTestEnv {
  const processEnv = opts.processEnv ?? process.env;
  const notes: string[] = [];
  const envFile = opts.config.llmTestEnvFile || ".env.test";
  const examplePath = join(opts.projectRoot, `${envFile}.example`);
  const altExample = join(opts.projectRoot, ".env.test.example");

  const profileFromEnv = processEnv.SLOPCONTROL_LLM_PROFILE?.trim().toLowerCase();
  const profile: LlmTestProfile =
    opts.forceProfile ??
    (profileFromEnv === "local" ||
    profileFromEnv === "fixture" ||
    profileFromEnv === "live"
      ? profileFromEnv
      : (opts.config.llmTestProfile ?? "local"));

  const project = resolveProjectEnv({
    projectRoot: opts.projectRoot,
    config: opts.config,
    processEnv,
  });
  notes.push(...project.notes);

  const fileEnv = loadDotEnvFile(join(opts.projectRoot, envFile));
  const exampleEnv = {
    ...loadDotEnvFile(altExample),
    ...loadDotEnvFile(examplePath),
  };
  const processOverrides = pickProcessOverrides(processEnv);

  let profileEnv: Record<string, string>;
  let source: string;

  if (profile === "live") {
    profileEnv = { ...loadLiveDockerEnv(opts.projectRoot) };
    source = "live:.env.docker";
    notes.push("live profile: using project .env.docker / .env.local");
  } else if (profile === "fixture") {
    profileEnv = { ...FIXTURE_DEFAULTS, ...exampleEnv, ...fileEnv };
    source = "fixture";
    notes.push("fixture profile: no live HTTP LLM");
  } else {
    profileEnv = { ...LOCAL_DEFAULTS, ...exampleEnv, ...fileEnv };
    source = "local";
    notes.push("local profile: local Ollama defaults + .env.test");
  }

  // Full project env first, then profile LLM keys, then process overrides for LLM keys
  const env = mergeEnvRecords(project.env, profileEnv, processOverrides);
  if (Object.keys(processOverrides).length > 0) {
    notes.push(`process.env LLM overrides: ${Object.keys(processOverrides).join(", ")}`);
    source = `process+${source}`;
  }

  if (profile !== "live") {
    applyModelMap(env, opts.config.llmModelMap);
    applyModelMap(env, opts.config.envMap);
  }

  env.SLOPCONTROL_LLM_PROFILE = profile;

  if (
    profile !== "live" &&
    /ollama\.cloud|api\.ollama\.cloud/i.test(env.OLLAMA_BASE_URL ?? "")
  ) {
    notes.push(
      "refusing free-tier Ollama Cloud URL for non-live profile; forcing local default",
    );
    env.OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
    if (!processOverrides.OLLAMA_API_KEY) {
      env.OLLAMA_API_KEY = "ollama";
    }
  }

  return { profile, env, source, notes };
}

/**
 * Probe an OpenAI-compat Ollama endpoint (GET /models or /v1/models).
 */
export async function probeLlmEndpoint(
  baseUrl: string,
  opts?: { timeoutMs?: number; apiKey?: string },
): Promise<{ ok: boolean; detail: string }> {
  const base = baseUrl.replace(/\/$/, "");
  if (base.startsWith("fixture://")) {
    return { ok: true, detail: "fixture endpoint (no probe)" };
  }
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const candidates = base.endsWith("/v1")
    ? [`${base}/models`]
    : [`${base}/v1/models`, `${base}/models`, `${base}/api/tags`];

  let last = "";
  for (const url of candidates) {
    try {
      const headers: Record<string, string> = {};
      if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        return { ok: true, detail: `probe OK ${url} (HTTP ${res.status})` };
      }
      last = `HTTP ${res.status} from ${url}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, detail: last || "probe failed" };
}

/**
 * Resolve test env and, for local profile, probe. Fall back to fixture if local is down.
 */
export async function resolveLlmTestEnvWithProbe(opts: {
  projectRoot: string;
  config: Pick<
    ProjectConfig,
    | "llmTestProfile"
    | "llmTestEnvFile"
    | "llmModelMap"
    | "envMap"
    | "envPassthroughKeys"
    | "envPassthroughPrefixes"
    | "worktreeSyncPaths"
  >;
  processEnv?: NodeJS.ProcessEnv;
  probe?: typeof probeLlmEndpoint;
}): Promise<ResolvedLlmTestEnv & { probeOk: boolean; probeDetail: string }> {
  const resolved = resolveLlmTestEnv(opts);
  if (resolved.profile !== "local") {
    return {
      ...resolved,
      probeOk: true,
      probeDetail:
        resolved.profile === "fixture"
          ? "fixture profile — probe skipped"
          : "live profile — probe skipped (use smoke separately)",
    };
  }

  const probeFn = opts.probe ?? probeLlmEndpoint;
  const probe = await probeFn(resolved.env.OLLAMA_BASE_URL ?? "", {
    apiKey: resolved.env.OLLAMA_API_KEY,
  });
  if (probe.ok) {
    return { ...resolved, probeOk: true, probeDetail: probe.detail };
  }

  const fixture = resolveLlmTestEnv({
    ...opts,
    forceProfile: "fixture",
  });
  fixture.notes.push(
    `local Ollama probe failed (${probe.detail}); fell back to fixture`,
  );
  return {
    ...fixture,
    probeOk: false,
    probeDetail: probe.detail,
  };
}

/** Merge overlay into a full env object for child processes. */
export function mergeEnvOverlay(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...base, ...overlay };
}

/**
 * Write committed-safe LLM test harness files if missing.
 * Does not overwrite existing files.
 */
export function scaffoldLlmTestHarness(projectRoot: string): {
  written: string[];
} {
  const written: string[] = [];
  const examplePath = join(projectRoot, ".env.test.example");
  if (!existsSync(examplePath)) {
    writeFileSync(examplePath, ENV_TEST_EXAMPLE, "utf-8");
    written.push(".env.test.example");
  }

  const helperPath = join(projectRoot, "tests/helpers/llm-test-client.ts");
  if (!existsSync(helperPath)) {
    mkdirSync(dirname(helperPath), { recursive: true });
    writeFileSync(helperPath, LLM_FIXTURE_HELPER, "utf-8");
    written.push("tests/helpers/llm-test-client.ts");
  }

  const fixturePath = join(projectRoot, "tests/fixtures/llm/ping.json");
  if (!existsSync(fixturePath)) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(
      fixturePath,
      `${JSON.stringify(
        {
          model: "fixture",
          messages: [{ role: "user", content: "ping" }],
          response: { content: "pong" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    written.push("tests/fixtures/llm/ping.json");
  }

  return { written };
}
