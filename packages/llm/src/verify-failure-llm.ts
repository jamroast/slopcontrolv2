import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

/**
 * LLM classifier for verification-step failures. Decision logic lives here;
 * the regex tree in @slopcontrol/artifacts failure-classify.ts is only a
 * catch-fallback (and deterministic signal extraction upstream).
 */

export const VerifyFailureClassSchema = z.enum([
  "infra",
  "product",
  "process",
  "model",
  "env",
  "unknown",
]);

export type VerifyFailureClass = z.infer<typeof VerifyFailureClassSchema>;

export const VerifyFailureLlmSchema = z.object({
  class: VerifyFailureClassSchema,
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  tags: z.array(z.string()),
  codingAgentShouldFix: z.boolean(),
  audience: z.enum(["operator", "coding"]),
  operatorActions: z.array(z.string()),
  lesson: z.string().optional(),
});

export type VerifyFailureLlmResult = z.infer<typeof VerifyFailureLlmSchema>;

/**
 * Deterministic facts extracted upstream (regex parsing, not decision logic).
 * The LLM judges from these + the output tail instead of raw blobs.
 */
export interface VerifyFailureSignals {
  /** `command not found` was parsed; kind classifies host utility vs node bin. */
  missingCommandKind?: "host-utility" | "node-bin" | "unknown" | null;
  missingCommand?: string | null;
  /** Our own CHECK_TIMEOUT marker (regex output truncation) was seen. */
  checkTimeout?: boolean;
  /** Exit code when known (0 = passed, 124 = wall-clock timeout, 127 = missing cmd). */
  exitCode?: number | null;
  /** Parsed "HTTP 4xx/5xx ..." provider status line, when present. */
  httpStatus?: number | null;
  /** ECONNREFUSED seen in output. */
  connectionRefused?: boolean;
}

export const VERIFY_FAILURE_SYSTEM_PROMPT = `You are SlopControl's verify-failure router. A step in a project's verification suite failed. Classify the failure into exactly one class so the right audience hears about it. Respond with ONLY a single JSON object.

Classes:
- "infra": external service/infrastructure failure — database, redis, or dev-server connection refused; "port already allocated/in use"; Docker daemon/network errors; model-provider entitlement or quota rejections (HTTP 401/403/429 from the LLM provider).
- "env": a required API key or environment variable is missing/empty/whitespace — the OPERATOR must set it (e.g. OLLAMA_API_KEY for cloud endpoints). Ignore dotenv "injecting env" TIP noise: keys listed there are present.
- "process": the Automated Check or workflow mechanics are broken, not the product — long-lived dev servers started inside checks; wall-clock timeouts (exit 124 / CHECK_TIMEOUT) with no "Test Files ... failed" line; a required host utility is not installed on this OS; git worktree/stash/merge conflicts; missing node binary (vite/tsc/eslint) that npm install would restore; shell syntax errors inside a check command ("unexpected token", "unmatched quote", "bad substitution"); soft-fail checks ending in "|| true"; module-resolution errors inside a test runner (vitest/jest cannot resolve a package).
- "product": genuine product-code failure — assertion/test failures ("Test Files ... failed", "FAIL ", AssertionError), TypeScript/compile errors in app code, ESLint errors in app code.
- "model": the product's LLM model itself is unavailable or too small (model not found on provider; structured JSON broken; context window exceeded; vision capability missing).
- "unknown": none of the above is clearly supported by the evidence.

Rules:
- Never recommend switching product models to free-tier IDs; tests should use llmTestProfile=local/fixture instead.
- codingAgentShouldFix: true for "process" (broken check) and "product"; false for "infra", "env", "model" — those need an operator or harness change.
- audience mirrors that: "coding" when the coding agent should fix it, "operator" otherwise.
- operatorActions: concrete operator steps, only when audience is "operator"; otherwise an empty array.
- tags: short kebab-case labels for routing/search (e.g. ["db","connection-refused"], ["check-timeout","broken-check"], ["missing-env","ollama"]). Empty array when nothing distinctive.
- summary: 1-2 sentences naming the concrete cause (include the service/command/env-var name when known).
- lesson: 1-2 sentence durable lesson for the project knowledge base, when the failure teaches something reusable (e.g. "Automated Checks must not start long-lived dev servers"); omit for one-off noise.
- confidence: "high" when the output states the cause outright, "medium" when inferred from strong signals, "low" when guessing.

Deterministic signals are provided as facts extracted upstream — treat them as ground truth, do not re-derive them from the output blob.`;

export interface ClassifyVerifyFailureViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  stepName?: string;
  command?: string;
  exitCode?: number;
  /** Deterministic pre-extraction from the caller (missing cmd, timeout, HTTP status...). */
  signals: VerifyFailureSignals;
  /** Failed step output; will be tail-clipped. */
  output: string;
  timeoutMs?: number;
}

const OUTPUT_TAIL_CHARS = 4_000;

function clipTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** Coerce a possibly-messy LLM payload into the schema (element-honor pattern). */
export function parseVerifyFailureLlmPayload(parsed: unknown): VerifyFailureLlmResult {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const cls = VerifyFailureClassSchema.safeParse(asObj.class);
  const audienceRaw = asObj.audience === "operator" ? "operator" : "coding";
  const shouldFix =
    typeof asObj.codingAgentShouldFix === "boolean"
      ? asObj.codingAgentShouldFix
      : audienceRaw === "coding";
  return VerifyFailureLlmSchema.parse({
    class: cls.success ? cls.data : "unknown",
    confidence: ["low", "medium", "high"].includes(asObj.confidence as string)
      ? asObj.confidence
      : "low",
    summary: typeof asObj.summary === "string" && asObj.summary.trim()
      ? asObj.summary.trim()
      : "Verification failed (unclassified).",
    tags: Array.isArray(asObj.tags)
      ? asObj.tags.filter((t): t is string => typeof t === "string")
      : [],
    codingAgentShouldFix: shouldFix,
    audience: audienceRaw,
    operatorActions: Array.isArray(asObj.operatorActions)
      ? asObj.operatorActions.filter(
          (a): a is string => typeof a === "string" && a.trim().length > 0,
        )
      : [],
    lesson:
      typeof asObj.lesson === "string" && asObj.lesson.trim()
        ? asObj.lesson.trim()
        : undefined,
  });
}

export async function classifyVerifyFailureViaLlm(
  opts: ClassifyVerifyFailureViaLlmOptions,
): Promise<VerifyFailureLlmResult> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs,
    system: VERIFY_FAILURE_SYSTEM_PROMPT,
    user: [
      `Step: ${opts.stepName ?? "(unknown)"}`,
      opts.command ? `Command: ${opts.command}` : "",
      opts.exitCode != null ? `Exit code: ${opts.exitCode}` : "",
      `Signals: ${JSON.stringify(opts.signals ?? {})}`,
      "",
      "Output (tail):",
      clipTail(opts.output ?? "", OUTPUT_TAIL_CHARS),
    ]
      .filter((line) => line !== "")
      .join("\n"),
  });
  return parseVerifyFailureLlmPayload(parsed);
}
