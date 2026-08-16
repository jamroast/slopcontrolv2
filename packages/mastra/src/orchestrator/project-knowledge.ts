import { randomUUID } from "node:crypto";
import type { Memory } from "@mastra/memory";

/** Per-project knowledge thread — OM summarizes it; agents read the summary. */
export function projectKnowledgeThreadId(projectId: string): string {
  return `project-knowledge-${projectId}`;
}

function toMemoryMessage(opts: {
  role: "user" | "assistant";
  text: string;
  threadId: string;
  resourceId: string;
}): {
  id: string;
  role: "user" | "assistant";
  createdAt: Date;
  threadId: string;
  resourceId: string;
  content: { format: 2; parts: Array<{ type: "text"; text: string }> };
} {
  return {
    id: randomUUID(),
    role: opts.role,
    createdAt: new Date(),
    threadId: opts.threadId,
    resourceId: opts.resourceId,
    content: {
      format: 2,
      parts: [{ type: "text", text: opts.text }],
    },
  };
}

/**
 * Append knowledge items (handoff knowledge, operator requirements, learning
 * cards) to the project knowledge thread. Fire-and-forget — the on-disk
 * handoff/learnings remain authoritative.
 */
export async function appendProjectKnowledge(opts: {
  memory: Memory | undefined;
  projectId: string;
  items: string[];
}): Promise<void> {
  if (!opts.memory || opts.items.length === 0) return;
  try {
    await opts.memory.saveMessages({
      messages: opts.items
        .map((item) => item.trim())
        .filter(Boolean)
        .map((text) =>
          toMemoryMessage({
            role: "assistant",
            text: text.slice(0, 500),
            threadId: projectKnowledgeThreadId(opts.projectId),
            resourceId: opts.projectId,
          }),
        ),
    });
  } catch {
    /* best-effort — never block the run on knowledge persistence */
  }
}

/**
 * Recall accumulated project knowledge as a prompt block. Prefers the OM
 * summary when available; falls back to the most recent items. Returns ""
 * on any failure — the block is additive, never load-bearing.
 */
export async function recallProjectKnowledge(opts: {
  memory: Memory | undefined;
  projectId: string;
  limit?: number;
}): Promise<string> {
  if (!opts.memory) return "";
  const limit = opts.limit ?? 20;
  try {
    const recalled = await opts.memory.recall({
      threadId: projectKnowledgeThreadId(opts.projectId),
      resourceId: opts.projectId,
      perPage: false,
    });
    const lines: string[] = [];
    for (const row of recalled.messages ?? []) {
      const msg = row as { role?: string; content?: unknown };
      if (msg.role !== "assistant") continue;
      const text = extractText(msg.content);
      if (text) lines.push(text);
    }
    if (lines.length === 0) return "";
    // Dedupe while preserving order, most recent first
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const line of lines.reverse()) {
      if (seen.has(line)) continue;
      seen.add(line);
      unique.push(line);
      if (unique.length >= limit) break;
    }
    return unique.map((line) => `- ${line}`).join("\n");
  } catch {
    return "";
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";
  const obj = content as { parts?: unknown; text?: unknown };
  if (typeof obj.text === "string") return obj.text.trim();
  if (Array.isArray(obj.parts)) {
    return obj.parts
      .filter(
        (p): p is { type: string; text: string } =>
          Boolean(p) &&
          typeof p === "object" &&
          (p as { type?: string }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}
