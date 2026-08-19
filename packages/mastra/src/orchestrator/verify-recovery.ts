import type { LlmEndpoint } from "@slopcontrol/types";
import type { LlmRegistry } from "@slopcontrol/llm";
import {
  buildVerifyRecoveryEvidence,
  formatVerifyRecoveryLog,
  isHarnessRecoverableStep,
  parseRecoveryExecutePayload,
  promoteLearning,
  validateAndRunRecoveryExecute,
  type RecoveryExecutePayload,
  type VerifyRecoveryStepInput,
} from "@slopcontrol/artifacts";
import {
  formatInvestigateDirtyTree,
  getCodingTool,
} from "@slopcontrol/coding-tools";

export type VerifyRecoveryAttemptResult =
  | { kind: "not_applicable" }
  | { kind: "skipped"; reason: string }
  | { kind: "executed"; exitCode: number; log: string; payload: RecoveryExecutePayload }
  | { kind: "rejected"; reason: string; log: string }
  | { kind: "investigate_failed"; reason: string };

const RECOVER_PROMPT = `Investigate this verify harness failure. Use bash probes only (no rm/install/ci during investigation).
When you understand the cause, respond with ONLY the JSON object described in your system prompt.`;

export async function runVerifyRecoveryInvestigation(opts: {
  verifyCwd: string;
  projectRoot: string;
  step: VerifyRecoveryStepInput;
  endpoint: LlmEndpoint;
  modelId?: string;
}): Promise<{ payload: RecoveryExecutePayload | null; output: string; dirtyWarning: string | null }> {
  const evidence = buildVerifyRecoveryEvidence({
    verifyCwd: opts.verifyCwd,
    projectRoot: opts.projectRoot,
    step: opts.step,
  });
  const tool = getCodingTool("pi");
  const session = await tool.createSession({
    projectDir: opts.verifyCwd,
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    mode: "recover",
  });
  try {
    if (tool.injectContext) {
      await tool.injectContext(session, "verify-failure", evidence.promptBlock);
    }
    const timeoutMs = Number(process.env.SLOPCONTROL_VERIFY_RECOVERY_MS ?? 120_000);
    const result = tool.runPromptWithSystem
      ? await tool.runPromptWithSystem(session, RECOVER_PROMPT, undefined, {
          timeoutMs,
        })
      : await tool.runPrompt(session, RECOVER_PROMPT, { timeoutMs });
    const changed = await tool.getChangedFiles(session);
    const dirtyWarning = formatInvestigateDirtyTree(changed);
    let payload = parseRecoveryExecutePayload(result.output);
    if (!payload && !result.aborted) {
      const retry = tool.runPromptWithSystem
        ? await tool.runPromptWithSystem(
            session,
            "Output ONLY the JSON execute object now. No prose.",
            undefined,
            { timeoutMs: 60_000 },
          )
        : await tool.runPrompt(session, "Output ONLY the JSON execute object now.", {
            timeoutMs: 60_000,
          });
      payload = parseRecoveryExecutePayload(retry.output);
    }
    return {
      payload,
      output: result.output,
      dirtyWarning,
    };
  } finally {
    await tool.abort(session).catch(() => undefined);
  }
}

export async function attemptVerifyRecovery(opts: {
  projectRoot: string;
  verifyCwd: string;
  step: VerifyRecoveryStepInput;
  registry?: LlmRegistry;
}): Promise<VerifyRecoveryAttemptResult> {
  if (!isHarnessRecoverableStep(opts.step)) {
    return { kind: "not_applicable" };
  }

  const evidence = buildVerifyRecoveryEvidence({
    verifyCwd: opts.verifyCwd,
    projectRoot: opts.projectRoot,
    step: opts.step,
  });
  if (evidence.recoveryAlreadyAttempted) {
    return { kind: "skipped", reason: "recovery already attempted this verify pass" };
  }

  if (!opts.registry) {
    return { kind: "skipped", reason: "no LLM registry bound" };
  }

  let endpoint: LlmEndpoint;
  let modelId: string | undefined;
  try {
    const resolved = opts.registry.resolveEndpointForRole("coding");
    endpoint = resolved.endpoint;
    modelId = resolved.modelId;
  } catch {
    return { kind: "skipped", reason: "coding endpoint unavailable for Pi recover" };
  }

  let investigation: Awaited<ReturnType<typeof runVerifyRecoveryInvestigation>>;
  try {
    investigation = await runVerifyRecoveryInvestigation({
      verifyCwd: opts.verifyCwd,
      projectRoot: opts.projectRoot,
      step: opts.step,
      endpoint,
      modelId,
    });
  } catch (err) {
    return {
      kind: "investigate_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (investigation.dirtyWarning) {
    return {
      kind: "rejected",
      reason: investigation.dirtyWarning,
      log: formatVerifyRecoveryLog({
        phase: "rejected",
        detail: investigation.dirtyWarning,
      }),
    };
  }

  if (!investigation.payload) {
    return {
      kind: "rejected",
      reason: "Pi recover did not emit RECOVERY_EXECUTE JSON",
      log: formatVerifyRecoveryLog({
        phase: "rejected",
        detail: "missing execute JSON",
      }),
    };
  }

  const ran = await validateAndRunRecoveryExecute({
    payload: investigation.payload,
    verifyCwd: opts.verifyCwd,
    projectRoot: opts.projectRoot,
  });

  if (!ran.ok) {
    return {
      kind: "rejected",
      reason: ran.reason,
      log: formatVerifyRecoveryLog({ phase: "rejected", detail: ran.reason }),
    };
  }

  const log = formatVerifyRecoveryLog({
    phase: "executed",
    execute: ran.normalized,
    exitCode: ran.exitCode,
    detail: investigation.payload.rationale.slice(0, 200),
  });

  promoteLearning(opts.projectRoot, {
    kind: "process",
    tags: ["verify-recovery", "harness", ...(evidence.installErrno ? [evidence.installErrno.toLowerCase()] : [])],
    title: `Verify recovery: ${opts.step.name}`,
    lesson: `Execute "${ran.normalized}" exit=${ran.exitCode}. ${investigation.payload.rationale}`.slice(
      0,
      500,
    ),
    severity: ran.exitCode === 0 ? "note" : "warning",
  });

  return {
    kind: "executed",
    exitCode: ran.exitCode,
    log,
    payload: investigation.payload,
  };
}
