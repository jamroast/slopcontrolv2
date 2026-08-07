import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

/**
 * LLM judge for ask/agent narration-only replies. The regex heuristic
 * (isAskNarrationOnlyReply) handles the cheap cases; this judge both confirms
 * heuristic hits and arbitrates heuristic misses (long working monologues
 * that blow the length caps) before a tools-disabled synthesis pass burns.
 */

export const NarrationJudgeResultSchema = z.object({
  narrationOnly: z.boolean(),
  reason: z.string(),
});

export type NarrationJudgeResult = z.infer<typeof NarrationJudgeResultSchema>;

export const ASK_NARRATION_SYSTEM_PROMPT = `You are SlopControl's narration judge. An agent answered an operator's question after making tool calls (reading files, grepping, listing). A heuristic suspects the reply is mid-loop narration rather than a real answer. Decide. Respond with ONLY a single JSON object.

narrationOnly=true (synthesis pass warranted) when the reply is progress chatter that conveys NONE of the tool findings:
- "Let me check…", "I'll look at X…", "Now reading file…", "One moment…"
- Describes what the agent is ABOUT to do, or restates the question, without delivering findings.

narrationOnly=false (keep the reply) when it carries ANY substantive answer content:
- Concrete findings: root cause, file/line references with explanation, code snippets, config values, behavior descriptions.
- A direct answer to the operator's question, a diagnosis, a plan, or instructions.
- Structured content (headings/bullets) that summarizes what the tools found.

The toolCallCount tells you the agent DID gather information. The question is only whether the reply conveys it. When unsure, prefer narrationOnly=false — a synthesis pass is expensive; only burn it when the reply clearly delivers nothing.`;

export interface JudgeNarrationOnlyViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  reply: string;
  toolCallCount: number;
  timeoutMs?: number;
}

const REPLY_CLIP_CHARS = 3_000;

/** Coerce a possibly-messy LLM payload into the narration verdict. */
export function parseNarrationJudgePayload(parsed: unknown): NarrationJudgeResult {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  return NarrationJudgeResultSchema.parse({
    // Unreadable verdict → keep current behavior (synthesize).
    narrationOnly:
      typeof asObj.narrationOnly === "boolean" ? asObj.narrationOnly : true,
    reason:
      typeof asObj.reason === "string" && asObj.reason.trim()
        ? asObj.reason.trim()
        : "LLM judge returned no reason — keeping the synthesis default.",
  });
}

export async function judgeNarrationOnlyViaLlm(
  opts: JudgeNarrationOnlyViaLlmOptions,
): Promise<NarrationJudgeResult> {
  const reply = opts.reply ?? "";
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs,
    system: ASK_NARRATION_SYSTEM_PROMPT,
    user: [
      `Tool calls made: ${opts.toolCallCount}`,
      "",
      "Agent reply under review:",
      reply.length <= REPLY_CLIP_CHARS
        ? reply
        : reply.slice(0, REPLY_CLIP_CHARS),
    ].join("\n"),
  });
  return parseNarrationJudgePayload(parsed);
}
