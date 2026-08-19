import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";

export const RecoveryExecutePayloadSchema = z.object({
  execute: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
});

export type RecoveryExecutePayload = z.infer<typeof RecoveryExecutePayloadSchema>;

const MAX_AND_SEGMENTS = 3;
const DENY_PATTERNS: RegExp[] = [
  /\bsudo\b/i,
  /\bcurl\b[^\n|]*\|\s*(ba)?sh/i,
  /\bwget\b[^\n|]*\|\s*(ba)?sh/i,
  /\brm\s+-rf\s+\//i,
  /\brm\s+-rf\s+~|\brm\s+-rf\s+\$HOME/i,
  /\brm\s+-rf\s+src\b/i,
  /\brm\s+-rf\s+app\b/i,
  /\brm\s+-rf\s+\.git\b/i,
  />\s*\.env/i,
  /\bcd\s+\.\./i,
  /\|\s*(ba)?sh\s*$/i,
];

const ALLOW_LOW_CONFIDENCE = false;

/**
 * Best-effort heuristic guard on model-proposed commands — NOT a sandbox.
 * Normalization (flag clusters, leading ./) plus rm-target path confinement
 * close the obvious bypasses, but a determined adversarial command can still
 * evade pattern matching; do not run recovery unattended on hostile input.
 */

/** Parse RECOVERY_EXECUTE JSON from Pi recover session output. */
export function parseRecoveryExecutePayload(
  text: string,
): RecoveryExecutePayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const brace = trimmed.match(/\{[\s\S]*"execute"[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);

  candidates.push(trimmed);

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return RecoveryExecutePayloadSchema.parse(parsed);
    } catch {
      // try next candidate
    }
  }
  return null;
}

function segmentsOf(command: string): string[] {
  return command
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalize rm-style flag clusters so the deny-list sees one canonical form. */
function normalizeRmFlags(segment: string): string {
  return segment.replace(
    /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\b/gi,
    (match, flags: string) =>
      /rf|fr/i.test(flags.replace(/-/g, "")) || match.includes("--")
        ? "rm -rf"
        : match,
  );
}

function normalizeExecuteForMatching(execute: string): string {
  return segmentsOf(execute)
    .map((seg) => normalizeRmFlags(seg).replace(/\brm\s+(-\S+\s+)?\.\//g, "rm $1"))
    .join(" && ");
}

/** Non-flag arguments of an rm segment, resolved and confined to the project root. */
function validateRmTargets(
  segment: string,
  verifyCwd: string,
  projectRoot: string,
): string | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "rm") return null;
  for (const raw of tokens.slice(1)) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (!token || token.startsWith("-")) continue;
    const abs = resolve(verifyCwd, token);
    if (!pathInsideRoot(abs, projectRoot)) {
      return `rm target escapes project root: ${token}`;
    }
  }
  return null;
}

function pathInsideRoot(target: string, root: string): boolean {
  const absRoot = resolve(root);
  const absTarget = resolve(root, target);
  return absTarget === absRoot || absTarget.startsWith(`${absRoot}/`);
}

/** Semantic guard before running agent-proposed execute statements. */
export function validateRecoveryExecute(opts: {
  execute: string;
  verifyCwd: string;
  projectRoot: string;
  confidence?: RecoveryExecutePayload["confidence"];
}): { ok: true; normalized: string } | { ok: false; reason: string } {
  const execute = opts.execute.trim();
  if (!execute) return { ok: false, reason: "empty execute statement" };

  if (opts.confidence === "low" && !ALLOW_LOW_CONFIDENCE) {
    return { ok: false, reason: "confidence low — operator escalation required" };
  }

  const normalized = normalizeExecuteForMatching(execute);

  for (const re of DENY_PATTERNS) {
    if (re.test(normalized)) {
      return { ok: false, reason: `denied pattern: ${re.source}` };
    }
  }

  const segments = segmentsOf(execute);
  if (segments.length > MAX_AND_SEGMENTS) {
    return {
      ok: false,
      reason: `too many && segments (max ${MAX_AND_SEGMENTS})`,
    };
  }

  const verifyAbs = resolve(opts.verifyCwd);
  const projectAbs = resolve(opts.projectRoot);
  if (!pathInsideRoot(verifyAbs, projectAbs)) {
    return { ok: false, reason: "verify cwd outside project root" };
  }

  for (const seg of segments) {
    const cdMatch = seg.match(/^cd\s+([^\s&;]+)/i);
    if (cdMatch?.[1]) {
      const target = cdMatch[1].replace(/^["']|["']$/g, "");
      if (!pathInsideRoot(resolve(verifyAbs, target), projectAbs)) {
        return { ok: false, reason: `cd escapes project root: ${target}` };
      }
    }
    const rmViolation = validateRmTargets(seg, verifyAbs, projectAbs);
    if (rmViolation) {
      return { ok: false, reason: rmViolation };
    }
  }

  return { ok: true, normalized: execute };
}

/** Minimal environment for recovery commands — model-proposed commands never see secrets. */
const RECOVERY_ENV_ALLOWLIST = /^PATH$|^HOME$|^TMPDIR$|^TEMP$|^TMP$|^TERM$|^SHELL$|^USER$|^LOGNAME$|^LANG$|^LC_|^CI$|^npm_config_|^PNPM_HOME$|^NPM_CONFIG|^YARN_|^COMPOSE_|^DOCKER_/;

export function buildRecoveryEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && RECOVERY_ENV_ALLOWLIST.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

export function runRecoveryExecute(opts: {
  execute: string;
  verifyCwd: string;
  timeoutMs?: number;
}): Promise<{ exitCode: number; output: string }> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const shell = process.env.SHELL?.trim() || "/bin/bash";

  return new Promise((resolvePromise) => {
    const child = spawn(shell, ["-c", opts.execute], {
      cwd: opts.verifyCwd,
      env: buildRecoveryEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = (stdout + stderr).slice(-20_000);
      resolvePromise({
        exitCode: code ?? 1,
        output,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        output: err.message,
      });
    });
  });
}

export async function validateAndRunRecoveryExecute(opts: {
  payload: RecoveryExecutePayload;
  verifyCwd: string;
  projectRoot: string;
  timeoutMs?: number;
}): Promise<
  | { ok: true; normalized: string; exitCode: number; output: string }
  | { ok: false; reason: string }
> {
  const validated = validateRecoveryExecute({
    execute: opts.payload.execute,
    verifyCwd: opts.verifyCwd,
    projectRoot: opts.projectRoot,
    confidence: opts.payload.confidence,
  });
  if (!validated.ok) return validated;

  const ran = await runRecoveryExecute({
    execute: validated.normalized,
    verifyCwd: opts.verifyCwd,
    timeoutMs: opts.timeoutMs,
  });
  return {
    ok: true,
    normalized: validated.normalized,
    exitCode: ran.exitCode,
    output: ran.output,
  };
}

export const VERIFY_RECOVERY_MARKER = "verify-recovery:";

export function verifyRecoveryAlreadyAttempted(text: string): boolean {
  return new RegExp(VERIFY_RECOVERY_MARKER, "i").test(text ?? "");
}

export function formatVerifyRecoveryLog(opts: {
  phase: "executed" | "rejected";
  execute?: string;
  exitCode?: number;
  detail?: string;
}): string {
  switch (opts.phase) {
    case "executed":
      return `${VERIFY_RECOVERY_MARKER} executed "${opts.execute ?? ""}" exit=${opts.exitCode ?? "?"}${opts.detail ? ` — ${opts.detail}` : ""}`;
    case "rejected":
      return `${VERIFY_RECOVERY_MARKER} rejected — ${opts.detail ?? "guard failed"}`;
  }
}
