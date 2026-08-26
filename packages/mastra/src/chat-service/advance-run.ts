import { isBusyRunStage, type RunStage } from "@slopcontrol/types";
import {
  decideAdvance,
  parseAdvanceEvent,
  type AdvanceDecision,
} from "./lifecycle-policy.js";
import { extractBusyRunFromLifecycleResult } from "./wait-run.js";

/**
 * Gated tools that mean "proceed with this run". After the operator confirms
 * one of these, keep advancing until work is running or we hit a real stop.
 * Do not include start_change / promote_ask — those must land in_review and wait.
 */
export const ADVANCE_AFTER_CONFIRM = new Set<string>([
  "advance_run",
  "submit_review",
  "start_development",
  "start_design",
  "retry_development",
]);

export type AdvanceDispatchResult = {
  text: string;
  isError?: boolean;
};

export type AdvanceStep = {
  tool: string;
  stageBefore: string;
  isError: boolean;
};

export type AdvanceRunResult = {
  runId: string;
  stage: string;
  steps: AdvanceStep[];
  kind: "working" | "stop" | "error";
  reason: string;
};

export type AdvanceGetStage = () =>
  | string
  | undefined
  | Promise<string | undefined>;

export function shouldAdvanceAfterConfirm(
  tool: string,
  args: Record<string, unknown>,
): boolean {
  if (!ADVANCE_AFTER_CONFIRM.has(tool)) return false;
  if (tool === "submit_review" && args.decision === "request_changes") {
    return false;
  }
  return true;
}

export function runIdFromLifecycle(
  args: Record<string, unknown>,
  resultText: string,
): string | undefined {
  if (typeof args.runId === "string" && args.runId.trim()) {
    return args.runId.trim();
  }
  return extractBusyRunFromLifecycleResult(resultText)?.runId;
}

export function stageFromDispatchText(text: string): string | undefined {
  const trimmed = text.replace(/^ERROR:\s*/i, "").trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
      stage?: unknown;
      run?: { stage?: unknown };
    };
    if (typeof parsed.stage === "string") return parsed.stage;
    if (typeof parsed.run?.stage === "string") return parsed.run.stage;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Extract a rejection reason from a dispatch result (e.g. submit_review refuse). */
export function reasonFromDispatchText(text: string): string | undefined {
  const trimmed = text.replace(/^ERROR:\s*/i, "").trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
      reason?: unknown;
    };
    if (typeof parsed.reason === "string" && parsed.reason.trim()) {
      return parsed.reason.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

async function resolveAdvanceStage(opts: {
  getStage: AdvanceGetStage;
  lastPayloadStage?: string;
  stageHint?: string;
}): Promise<string> {
  const live = (await opts.getStage())?.trim() || undefined;
  if (live && isBusyRunStage(live)) return live;
  if (opts.lastPayloadStage) return opts.lastPayloadStage;
  if (live) return live;
  return opts.stageHint?.trim() || "idle";
}

async function applyDecision(
  opts: {
    dispatch: (
      tool: string,
      args: Record<string, unknown>,
    ) => Promise<AdvanceDispatchResult>;
    scoped: (args: Record<string, unknown>) => Record<string, unknown>;
  },
  decision: AdvanceDecision,
  stageBefore: string,
): Promise<{
  dispatched?: AdvanceDispatchResult;
  step?: AdvanceStep;
}> {
  if (decision.kind !== "dispatch") return {};
  const dispatched = await opts.dispatch(
    decision.tool,
    opts.scoped(decision.args),
  );
  return {
    dispatched,
    step: {
      tool: decision.tool,
      stageBefore,
      isError: Boolean(dispatched.isError),
    },
  };
}

/**
 * Drive a run from a gate until work is running or a real blocker.
 * Observe stage, apply decideAdvance(stage, event), re-observe.
 */
export async function advanceRun(opts: {
  runId: string;
  projectId?: string;
  getStage: AdvanceGetStage;
  /** Used when the store has not caught up after a just-confirmed tool. */
  stageHint?: string;
  dispatch: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<AdvanceDispatchResult>;
  maxSteps?: number;
  /** Recover from the just-confirmed tool when it returned a known gate error. */
  seedError?: string;
  /** Text from the just-confirmed tool (e.g. submit_review refuse with reason). */
  seedDispatchText?: string;
}): Promise<AdvanceRunResult> {
  const steps: AdvanceStep[] = [];
  const attempted = new Set<string>();
  const maxSteps = opts.maxSteps ?? 6;
  let lastPayloadStage = opts.stageHint?.trim() || undefined;
  let lastReason =
    reasonFromDispatchText(opts.seedDispatchText ?? "") ?? undefined;
  const scoped = (args: Record<string, unknown>) => ({
    ...args,
    runId: opts.runId,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });

  const currentStage = () =>
    resolveAdvanceStage({
      getStage: opts.getStage,
      lastPayloadStage,
      stageHint: opts.stageHint,
    });

  const finish = async (
    kind: AdvanceRunResult["kind"],
    reason: string,
  ): Promise<AdvanceRunResult> => {
    const stage = await currentStage();
    return { runId: opts.runId, stage, steps, kind, reason };
  };

  if (opts.seedError) {
    const event = parseAdvanceEvent(opts.seedError);
    if (event.type === "unknown_error") {
      /* fall through to the proceed loop using observed stage */
    } else {
      const recover = decideAdvance(await currentStage(), event);
      if (recover.kind === "working") {
        return finish("working", "Work is already running.");
      }
      if (recover.kind === "dispatch") {
        const { dispatched, step } = await applyDecision(
          { dispatch: opts.dispatch, scoped },
          recover,
          await currentStage(),
        );
        if (step) steps.push(step);
        if (dispatched?.isError) {
          return finish("error", dispatched.text.slice(0, 800));
        }
        lastPayloadStage =
          stageFromDispatchText(dispatched?.text ?? "") ?? lastPayloadStage;
      }
    }
  }

  for (let i = 0; i < maxSteps; i++) {
    const stage = await currentStage();
    const decision = decideAdvance(stage, { type: "proceed" });
    if (decision.kind === "working") {
      return finish("working", `Work is running (${stage}).`);
    }
    if (decision.kind === "stop") {
      return finish("stop", decision.reason);
    }

    const key = `${stage}:${decision.tool}`;
    if (attempted.has(key)) {
      return finish(
        "stop",
        `Stuck at ${stage} after ${decision.tool}.` +
          (lastReason ? ` ${lastReason}` : ""),
      );
    }
    attempted.add(key);

    const { dispatched, step } = await applyDecision(
      { dispatch: opts.dispatch, scoped },
      decision,
      stage,
    );
    if (step) steps.push(step);
    if (!dispatched) {
      return finish("stop", `Failed to dispatch ${decision.tool}.`);
    }

    if (dispatched.isError) {
      const event = parseAdvanceEvent(dispatched.text);
      if (event.type === "unknown_error") {
        return finish("error", event.detail);
      }
      const recover = decideAdvance(stage, event);
      if (recover.kind === "working") {
        return finish("working", "Work is already running.");
      }
      if (recover.kind === "dispatch") {
        const recoverKey = `${stage}:${recover.tool}`;
        if (!attempted.has(recoverKey)) {
          attempted.add(recoverKey);
          const recovered = await applyDecision(
            { dispatch: opts.dispatch, scoped },
            recover,
            stage,
          );
          if (recovered.step) steps.push(recovered.step);
          if (recovered.dispatched?.isError) {
            return finish(
              "error",
              recovered.dispatched.text.slice(0, 800),
            );
          }
          lastPayloadStage =
            stageFromDispatchText(recovered.dispatched?.text ?? "") ??
            lastPayloadStage;
          continue;
        }
      }
      return finish("error", dispatched.text.slice(0, 800));
    }

    lastPayloadStage =
      stageFromDispatchText(dispatched.text) ?? lastPayloadStage;
    lastReason = reasonFromDispatchText(dispatched.text) ?? lastReason;
  }

  const stage = await currentStage();
  return finish(
    isBusyRunStage(stage) ? "working" : "stop",
    isBusyRunStage(stage)
      ? `Work is running (${stage}).`
      : `Stopped after ${maxSteps} steps at ${stage}.`,
  );
}

export function formatAdvanceRunResult(result: AdvanceRunResult): string {
  const trail =
    result.steps.length > 0
      ? ` Steps: ${result.steps.map((s) => s.tool).join(" → ")}.`
      : "";
  return `Lifecycle advance for run ${result.runId}: now ${result.stage}.${trail} ${result.reason}`;
}

export function isWorkingRunStage(stage: string): stage is RunStage {
  return isBusyRunStage(stage);
}
