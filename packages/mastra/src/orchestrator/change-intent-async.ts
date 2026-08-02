import {
  extractChangeIntent,
  finalizeChangeIntent,
  findPriorUiMountIntent,
  isChangeIntentWeak,
  readChangeIntent,
  writeChangeIntent,
  type ChangeIntent,
} from "@slopcontrol/artifacts";
import {
  extractChangeIntentViaLlm,
  type LlmRegistry,
} from "@slopcontrol/llm";
import { log } from "@slopcontrol/types";

export type EnsureChangeIntentAsyncOptions = {
  registry?: LlmRegistry | null;
  /** Force re-extract even when existing Intent is strong. */
  force?: boolean;
  /** Skip LLM; use heuristic extract only (offline tests). */
  heuristicOnly?: boolean;
  roleOverrides?: Parameters<LlmRegistry["resolveEndpointForRole"]>[1];
};

/**
 * Ensure INTENT.json exists using planning-role LLM classification when
 * available, with heuristic fallback. Sync `ensureChangeIntent` remains for
 * unit tests and paths without a registry.
 */
export async function ensureChangeIntentAsync(
  projectRoot: string,
  phaseId: string,
  description: string,
  opts?: EnsureChangeIntentAsyncOptions,
): Promise<ChangeIntent> {
  const existing = readChangeIntent(projectRoot, phaseId);
  if (
    existing &&
    !opts?.force &&
    !isChangeIntentWeak(existing, description)
  ) {
    return existing;
  }

  const useHeuristic =
    opts?.heuristicOnly === true || !opts?.registry;

  if (!useHeuristic && opts?.registry) {
    try {
      const { endpoint, modelId } = opts.registry.resolveEndpointForRole(
        "classification",
        opts.roleOverrides,
      );
      const prior = findPriorUiMountIntent(projectRoot, phaseId);
      const priorMountSummary = prior
        ? `phase ${prior.phaseId}: uiMount=${prior.intent.uiMount}${
            prior.intent.changeKind
              ? ` changeKind=${prior.intent.changeKind}`
              : ""
          }`
        : undefined;
      const llmOut = await extractChangeIntentViaLlm({
        endpoint,
        modelId,
        description,
        priorMountSummary,
        timeoutMs: 15_000,
      });
      const intent = finalizeChangeIntent(llmOut, {
        description,
        projectRoot,
        phaseId,
      });
      writeChangeIntent(projectRoot, phaseId, intent);
      log.info("intent", "Change Intent via LLM (planning)", {
        phaseId,
        changeKind: intent.changeKind,
        uiMount: intent.uiMount,
        hasInteraction: Boolean(intent.interaction),
      });
      return intent;
    } catch (err) {
      log.warn("intent", "LLM Change Intent failed; heuristic fallback", {
        phaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const intent = extractChangeIntent(description, { projectRoot, phaseId });
  writeChangeIntent(projectRoot, phaseId, intent);
  log.info("intent", "Change Intent via heuristic", {
    phaseId,
    changeKind: intent.changeKind,
    uiMount: intent.uiMount,
    hasInteraction: Boolean(intent.interaction),
    heuristicOnly: useHeuristic,
  });
  return intent;
}

/**
 * Preview Intent without writing (LLM when registry available).
 */
export async function previewChangeIntentAsync(
  description: string,
  opts: {
    projectRoot?: string;
    phaseId?: string;
    registry?: LlmRegistry | null;
    heuristicOnly?: boolean;
    roleOverrides?: Parameters<LlmRegistry["resolveEndpointForRole"]>[1];
  },
): Promise<{ intent: ChangeIntent; source: "llm" | "heuristic" }> {
  const useHeuristic =
    opts.heuristicOnly === true || !opts.registry;

  if (!useHeuristic && opts.registry) {
    try {
      const { endpoint, modelId } = opts.registry.resolveEndpointForRole(
        "classification",
        opts.roleOverrides,
      );
      const prior =
        opts.projectRoot != null
          ? findPriorUiMountIntent(opts.projectRoot, opts.phaseId)
          : null;
      const priorMountSummary = prior
        ? `phase ${prior.phaseId}: uiMount=${prior.intent.uiMount}`
        : undefined;
      const llmOut = await extractChangeIntentViaLlm({
        endpoint,
        modelId,
        description,
        priorMountSummary,
        timeoutMs: 15_000,
      });
      return {
        intent: finalizeChangeIntent(llmOut, {
          description,
          projectRoot: opts.projectRoot,
          phaseId: opts.phaseId,
        }),
        source: "llm",
      };
    } catch (err) {
      log.warn("intent", "preview LLM Intent failed; heuristic", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    intent: extractChangeIntent(description, {
      projectRoot: opts.projectRoot,
      phaseId: opts.phaseId,
    }),
    source: "heuristic",
  };
}
