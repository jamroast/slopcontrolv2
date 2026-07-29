/**
 * Gate: do not mark an Ollama/OpenAI-routing phase complete when APPENDIX is
 * dominated by turn timeouts and the merge never touched the promised routing files.
 */

/** Strong signals that PHASE promised product routing implementation (not mere env URL mention). */
const API_ROUTING_PROMISE_RE =
  /resolveModelId|model-resolver|openai[- ]compatible|api\.ollama\.cloud|ollama\.com\/v1|:cloud\s*suffix/i;

/** Product / env / docker files that address Ollama routing or embedded-host removal. */
const API_ROUTING_FILE_RE =
  /(^|\/)(model-resolver|chat-agent|embeddings|instrumentation)\.[tj]sx?$|(^|\/)api\/chat\/route\.[tj]sx?$|(^|\/)\.env\.docker(\.example)?$|(^|\/)\.env\.local$|(^|\/)docker-compose\.ya?ml$|(^|\/)scripts\/docker\.ts$/i;

/** Diffs that are documentation / catalogue / test-only relative to API routing. */
const THIN_FILE_RE =
  /(model-catalogue|scripts\/env\.ts|\.slopcontrol\/|LEARNINGS\.md|RESEARCH\.md|PHASE\.md|APPENDIX\.md|\.test\.[tj]sx?$|\.md$)/i;

const DEVELOP_PASS_MARKER = "## Develop pass started";

export type ApiRoutingCompleteGateInput = {
  appendix: string;
  phaseDoc: string;
  researchDoc?: string;
  /** Files changed in the completing coding iteration (worktree + session). */
  changedFiles: string[];
  /**
   * Extra paths known to have been edited this pass even if gitignored
   * (e.g. `.env.docker` synced from worktree).
   */
  envTouchedPaths?: string[];
  /** Minimum probe/timeout APPENDIX hits before the gate can fire (default 2). */
  minTimeoutHits?: number;
};

export type ApiRoutingCompleteGateResult = {
  allowComplete: boolean;
  reason?: string;
  timeoutHits: number;
  promisesApiRouting: boolean;
  addressesApiRouting: boolean;
};

/**
 * True when PHASE lists model-resolver / chat-agent / embeddings / api/chat as
 * Out of scope or No change — env/docker-only phases should not force those diffs.
 */
export function phaseMarksRoutingFilesOutOfScope(phaseDoc: string): boolean {
  const text = phaseDoc ?? "";
  // Look for "No change" / "Out of scope" near routing file names
  const blocks = text.split(/\n(?=## |\|)/);
  const scoped = blocks.some((block) => {
    const noChange =
      /\bno change\b|\bout of scope\b|\bdo not (?:edit|change|touch)\b/i.test(
        block,
      );
    if (!noChange) return false;
    return /model-resolver|chat-agent|embeddings|api\/chat\/route/i.test(block);
  });
  if (scoped) return true;
  // Table rows: | `src/lib/model-resolver.ts` | **No change** |
  return /model-resolver[\s\S]{0,120}No change|chat-agent[\s\S]{0,120}No change|embeddings[\s\S]{0,120}No change|api\/chat\/route[\s\S]{0,120}No change/i.test(
    text,
  );
}

export function phasePromisesApiRouting(
  phaseDoc: string,
  researchDoc = "",
): boolean {
  const combined = `${phaseDoc}\n${researchDoc}`;
  if (!API_ROUTING_PROMISE_RE.test(combined)) return false;
  if (phaseMarksRoutingFilesOutOfScope(phaseDoc)) return false;
  return true;
}

const TIMEOUT_HIT_RE =
  /probe\/timeout abort|turn_timeout|coding turn aborted:\s*turn_timeout|coding LLM stall\/throttle abort/i;
const TIMEOUT_HIT_GLOBAL_RE =
  /probe\/timeout abort|turn_timeout|coding turn aborted:\s*turn_timeout|coding LLM stall\/throttle abort/gi;

/**
 * Count timeout/probe hits in APPENDIX, preferring only the current develop pass
 * (text after the last "## Develop pass started" marker).
 *
 * When APPENDIX uses `##` sections, count at most one hit per section so a
 * `probe/timeout abort` heading plus a `turn_timeout` body line are not
 * double-counted. Bare token lists (no headings) still count each match.
 */
export function countAppendixTimeoutHits(appendix: string): number {
  const text = appendix ?? "";
  const markerIdx = text.lastIndexOf(DEVELOP_PASS_MARKER);
  const slice = markerIdx >= 0 ? text.slice(markerIdx) : text;
  if (/^## /m.test(slice)) {
    const sections = slice
      .split(/(?=^## )/m)
      .filter((s) => s.trim().length > 0);
    return sections.filter((s) => TIMEOUT_HIT_RE.test(s)).length;
  }
  return (slice.match(TIMEOUT_HIT_GLOBAL_RE) ?? []).length;
}

export function changedFilesAddressApiRouting(files: string[]): boolean {
  return (files ?? []).some((f) =>
    API_ROUTING_FILE_RE.test(f.replace(/\\/g, "/")),
  );
}

export function isThinApiRoutingDiff(files: string[]): boolean {
  const normalized = (files ?? [])
    .map((f) => f.replace(/\\/g, "/"))
    .filter(Boolean);
  if (normalized.length === 0) return true;
  const productish = normalized.filter((f) => !THIN_FILE_RE.test(f));
  return productish.length === 0;
}

/**
 * Refuse complete when an API-routing PHASE/RESEARCH was promised, APPENDIX
 * shows repeated coding timeouts, and the landing diff never touched routing files.
 */
export function evaluateApiRoutingCompleteGate(
  input: ApiRoutingCompleteGateInput,
): ApiRoutingCompleteGateResult {
  const minHits = input.minTimeoutHits ?? 2;
  const promisesApiRouting = phasePromisesApiRouting(
    input.phaseDoc,
    input.researchDoc,
  );
  const timeoutHits = countAppendixTimeoutHits(input.appendix);
  const allFiles = [
    ...(input.changedFiles ?? []),
    ...(input.envTouchedPaths ?? []),
  ];
  const addressesApiRouting = changedFilesAddressApiRouting(allFiles);

  if (!promisesApiRouting) {
    return {
      allowComplete: true,
      timeoutHits,
      promisesApiRouting,
      addressesApiRouting,
    };
  }
  if (timeoutHits < minHits) {
    return {
      allowComplete: true,
      timeoutHits,
      promisesApiRouting,
      addressesApiRouting,
    };
  }
  if (addressesApiRouting) {
    return {
      allowComplete: true,
      timeoutHits,
      promisesApiRouting,
      addressesApiRouting,
    };
  }

  return {
    allowComplete: false,
    timeoutHits,
    promisesApiRouting,
    addressesApiRouting,
    reason: [
      "API-routing complete gate: APPENDIX has repeated coding turn timeouts,",
      "but the completing diff did not touch promised routing files",
      "(model-resolver, chat-agent, embeddings, api/chat/route, .env.docker, docker-compose.yml, scripts/docker.ts).",
      `timeoutHits=${timeoutHits}; changed=[${allFiles.slice(0, 12).join(", ") || "none"}].`,
      "Do not mark complete on catalogue/docs/tests-only merges when PHASE/RESEARCH promised OpenAI/Ollama API routing.",
      "Implement the promised resolver/env/chat/docker changes (or rewrite PHASE to match what landed), then re-verify.",
    ].join(" "),
  };
}

export const DEVELOP_PASS_APPENDIX_MARKER = DEVELOP_PASS_MARKER;
