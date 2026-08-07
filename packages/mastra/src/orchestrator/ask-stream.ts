/**
 * Live-turn streaming helpers: progress events, narration detection, chunk parsing.
 * Shared by ask / agent / design / plan interactive turns.
 */

export type LiveProgressEvent =
  | { type: "status"; summary: string }
  | { type: "tool_call"; tool: string; summary: string }
  | { type: "tool_result"; tool: string; summary: string }
  | { type: "text"; text: string };

/** @deprecated Use LiveProgressEvent */
export type AskProgressEvent = LiveProgressEvent;

export type LiveProgressCallback = (event: LiveProgressEvent) => void;

/** @deprecated Use LiveProgressCallback */
export type AskProgressCallback = LiveProgressCallback;

export class LiveTurnInterruptedError extends Error {
  readonly code = "interrupted" as const;
  readonly partialReply: string;

  constructor(message = "Live turn interrupted", partialReply = "") {
    super(message);
    this.name = "LiveTurnInterruptedError";
    this.partialReply = partialReply;
  }
}

export function isLiveTurnInterruptedError(
  error: unknown,
): error is LiveTurnInterruptedError {
  return (
    error instanceof LiveTurnInterruptedError ||
    (error instanceof Error &&
      (/Live turn interrupted|interrupted after/i.test(error.message) ||
        (error as { code?: string }).code === "interrupted"))
  );
}

/** Truncate for SSE / MCP progress lines. */
export function clipAskProgress(text: string, max = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Summarize tool args for progress (paths / patterns only). */
export function summarizeToolArgs(
  toolName: string,
  args: unknown,
): string {
  if (!args || typeof args !== "object") return toolName;
  const a = args as Record<string, unknown>;
  const parts: string[] = [toolName];
  for (const key of ["path", "file", "pattern", "query", "url", "glob"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) {
      parts.push(`${key}=${clipAskProgress(v, 80)}`);
    }
  }
  if (parts.length === 1) {
    try {
      parts.push(clipAskProgress(JSON.stringify(a), 100));
    } catch {
      /* ignore */
    }
  }
  return parts.join(" ");
}

/** One-line tool result for progress. */
export function summarizeToolResult(toolName: string, result: unknown): string {
  if (result == null) return `${toolName} → (empty)`;
  if (typeof result === "string") {
    return `${toolName} → ${clipAskProgress(result, 120)}`;
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.error === "string") {
      return `${toolName} → error: ${clipAskProgress(r.error, 100)}`;
    }
    if (typeof r.count === "number") {
      return `${toolName} → ${r.count} match(es)`;
    }
    if (Array.isArray(r.matches)) {
      return `${toolName} → ${r.matches.length} match(es)`;
    }
    if (Array.isArray(r.files)) {
      return `${toolName} → ${r.files.length} file(s)`;
    }
    if (typeof r.content === "string") {
      const lines =
        typeof r.lines === "number"
          ? r.lines
          : r.content.split("\n").length;
      return `${toolName} → ${lines} line(s)`;
    }
    if (r.ok === false) {
      return `${toolName} → failed`;
    }
    if (r.ok === true) {
      return `${toolName} → ok`;
    }
  }
  return `${toolName} → done`;
}

/**
 * Deterministic "this is a real answer" markers. When present the reply is
 * treated as substantive: no synthesis pass and no judge call is burned.
 */
export function hasSubstantiveReplyMarkers(text: string): boolean {
  const body = (text ?? "").trim();
  if (!body) return false;
  if (/##\s*Task brief/i.test(body)) return true;
  if (/\broot cause\b/i.test(body)) return true;
  if (/\bdiagnosis\b/i.test(body) && body.length > 200) return true;
  if (/^#{1,3}\s+/m.test(body) && body.length > 280) return true;
  const pathHits = (body.match(/[`']?[a-zA-Z0-9_./-]+\.(tsx?|jsx?|css|md)/g) ?? [])
    .length;
  if (pathHits >= 2 && body.length > 400 && !/^Let me\b/i.test(body)) {
    return true;
  }
  return false;
}

/**
 * True when the agent returned mid-loop narration without a real answer.
 * Used to trigger a tools-disabled synthesis pass.
 */
export function isAskNarrationOnlyReply(text: string): boolean {
  const body = (text ?? "").trim();
  if (!body) return true;
  if (hasSubstantiveReplyMarkers(body)) return false;

  const letMe =
    (body.match(/\bLet me (?:investigate|check|verify|look|start|confirm)\b/gi) ??
      []).length;
  const sentences = body.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
  if (letMe >= 2 && body.length < 1200) return true;
  if (letMe >= 1 && sentences.length <= 4 && body.length < 900) return true;
  if (/:\s*$/.test(body) && letMe >= 1) return true;
  return false;
}

/** Structural verdict shape (mirrors @slopcontrol/llm ask-narration-llm). */
export type NarrationJudgeVerdict = {
  narrationOnly?: boolean;
  reason?: string;
};

/**
 * Injected LLM narration judge — the heuristic is a cheap pre-filter, the
 * judge decides whether a synthesis pass is actually burned.
 */
export type NarrationJudgeFn = (input: {
  reply: string;
  toolCallCount: number;
}) => Promise<NarrationJudgeVerdict>;

export type NarrationSynthesisDecision = {
  synthesize: boolean;
  /** True when the regex heuristic flagged the reply as narration. */
  heuristicFlagged: boolean;
  /** Heuristic flagged narration but the judge denied the synthesis pass. */
  judgeOverrode: boolean;
  judgeReason?: string;
};

/**
 * Narration→synthesis decision. The heuristic handles the cheap cases; the
 * LLM judge arbitrates both directions:
 *  - heuristic flags narration → judge confirms before a synthesis pass burns;
 *  - heuristic misses (long concatenated monologue from a step-exhausted agent
 *    blows the length caps) → judge is consulted unless the reply carries
 *    substantive-answer markers.
 * Judge deny keeps the reply; judge error keeps prior behavior (synthesize on
 * heuristic hit, keep reply on heuristic miss).
 */
export async function decideNarrationSynthesis(opts: {
  reply: string;
  toolCallCount: number;
  synthesizeIfNarration?: boolean;
  judgeFn?: NarrationJudgeFn | null;
}): Promise<NarrationSynthesisDecision> {
  const no = { synthesize: false, heuristicFlagged: false, judgeOverrode: false };
  if (opts.synthesizeIfNarration === false) return no;
  if (opts.toolCallCount <= 0) return no;

  if (isAskNarrationOnlyReply(opts.reply)) {
    if (!opts.judgeFn)
      return { synthesize: true, heuristicFlagged: true, judgeOverrode: false };
    try {
      const verdict = await opts.judgeFn({
        reply: opts.reply,
        toolCallCount: opts.toolCallCount,
      });
      if (verdict.narrationOnly === false) {
        return {
          synthesize: false,
          heuristicFlagged: true,
          judgeOverrode: true,
          judgeReason: verdict.reason,
        };
      }
      return {
        synthesize: true,
        heuristicFlagged: true,
        judgeOverrode: false,
        judgeReason: verdict.reason,
      };
    } catch {
      return { synthesize: true, heuristicFlagged: true, judgeOverrode: false };
    }
  }

  // Heuristic miss. Substantive markers → deterministic no; otherwise the
  // length-capped heuristic may be hiding an unfinished monologue, so let the
  // judge arbitrate. No judge / judge error → keep prior no-synthesis behavior.
  if (hasSubstantiveReplyMarkers(opts.reply)) return no;
  if (!opts.judgeFn) return no;
  try {
    const verdict = await opts.judgeFn({
      reply: opts.reply,
      toolCallCount: opts.toolCallCount,
    });
    if (verdict.narrationOnly) {
      return {
        synthesize: true,
        heuristicFlagged: false,
        judgeOverrode: false,
        judgeReason: verdict.reason,
      };
    }
    return {
      synthesize: false,
      heuristicFlagged: false,
      judgeOverrode: false,
      judgeReason: verdict.reason,
    };
  } catch {
    return no;
  }
}

/** Map a Mastra stream chunk to zero-or-more progress events. */
export function askProgressFromStreamChunk(
  chunk: unknown,
): LiveProgressEvent[] {
  if (!chunk || typeof chunk !== "object") return [];
  const c = chunk as {
    type?: string;
    payload?: Record<string, unknown>;
  };
  const type = c.type;
  const payload = c.payload ?? {};

  if (type === "tool-call") {
    const tool = String(payload.toolName ?? "tool");
    return [
      {
        type: "tool_call",
        tool,
        summary: summarizeToolArgs(tool, payload.args),
      },
    ];
  }
  if (type === "tool-result") {
    const tool = String(payload.toolName ?? "tool");
    return [
      {
        type: "tool_result",
        tool,
        summary: summarizeToolResult(tool, payload.result),
      },
    ];
  }
  if (type === "tool-error") {
    const tool = String(payload.toolName ?? "tool");
    const err =
      typeof payload.error === "string"
        ? payload.error
        : payload.error != null
          ? String(payload.error)
          : "tool error";
    return [
      {
        type: "tool_result",
        tool,
        summary: `${tool} → error: ${clipAskProgress(err, 100)}`,
      },
    ];
  }
  if (type === "text-delta") {
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text) return [];
    return [{ type: "text", text }];
  }
  if (type === "step-start") {
    return [{ type: "status", summary: "step" }];
  }
  return [];
}

/** Build a live "Working…" transcript stub from progress events. */
export function formatAskWorkingStub(lines: string[]): string {
  const unique = [...new Set(lines.filter(Boolean))].slice(-24);
  if (unique.length === 0) return "Working…";
  return `Working…\n${unique.map((l) => `- ${l}`).join("\n")}`;
}

export function askProgressLine(event: LiveProgressEvent): string | null {
  switch (event.type) {
    case "tool_call":
      return event.summary;
    case "tool_result":
      return event.summary;
    case "status":
      return event.summary === "step" ? null : event.summary;
    case "text":
      return null;
    default:
      return null;
  }
}

export const ASK_SYNTHESIS_PROMPT_PREFIX = `You already investigated with tools. Write the final operator-facing answer now.
Do NOT call tools. Do NOT say "Let me check". Cite paths you already saw.
If this is an implementable fix, include ## Task brief with Title, Goal, Likely areas, and Success Criteria that match claim-vs-proof (mount + style visibility when relevant).

Prior operator message and context follow.
`;

/** Fingerprint tool call for watcher repeat detection. */
export function toolCallFingerprint(tool: string, summary: string): string {
  return `${tool}|${summary.replace(/\s+/g, " ").trim().slice(0, 120)}`;
}
