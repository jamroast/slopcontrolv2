import { randomUUID } from "node:crypto";
import type { Memory } from "@mastra/memory";
import type { PersistedDiagnosis } from "@slopcontrol/artifacts";

/** Per-project thread of past failure diagnoses (failure history memory). */
export function diagnosesThreadId(projectId: string): string {
  return `diagnoses-${projectId}`;
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

/** Compact one-line rendering of a diagnosis for the history thread. */
export function formatDiagnosisHistoryLine(d: PersistedDiagnosis): string {
  const resolution = (d.nextActions ?? "").trim().slice(0, 200);
  return [
    `[${d.fingerprint}] ${d.class}: ${d.title}`,
    `rootCause: ${(d.rootCause ?? "").trim().slice(0, 300)}`,
    resolution ? `resolution: ${resolution}` : null,
  ]
    .filter(Boolean)
    .join(" — ");
}

/**
 * Append a diagnosis to the per-project history thread. Fire-and-forget —
 * the on-disk DIAGNOSIS.json remains authoritative; Memory is the recall
 * layer for retry prompts.
 */
export async function appendDiagnosisToMemory(opts: {
  memory: Memory | undefined;
  projectId: string;
  diagnosis: PersistedDiagnosis;
}): Promise<void> {
  if (!opts.memory) return;
  try {
    await opts.memory.saveMessages({
      messages: [
        toMemoryMessage({
          role: "assistant",
          text: formatDiagnosisHistoryLine(opts.diagnosis),
          threadId: diagnosesThreadId(opts.projectId),
          resourceId: opts.projectId,
        }),
      ],
    });
  } catch {
    /* best-effort — never block the run on history persistence */
  }
}

/**
 * Recall the most recent diagnosis history lines for a project (most recent
 * first). Returns [] on any failure — history is additive, never load-bearing.
 */
export async function recallDiagnosisHistory(opts: {
  memory: Memory | undefined;
  projectId: string;
  limit?: number;
}): Promise<string[]> {
  if (!opts.memory) return [];
  const limit = opts.limit ?? 10;
  try {
    const recalled = await opts.memory.recall({
      threadId: diagnosesThreadId(opts.projectId),
      resourceId: opts.projectId,
      perPage: false,
    });
    const lines: string[] = [];
    for (const row of recalled.messages ?? []) {
      const msg = row as {
        role?: string;
        content?: unknown;
      };
      if (msg.role !== "assistant") continue;
      const text = extractText(msg.content);
      if (text) lines.push(text);
    }
    // recall returns oldest-first; we want most recent first
    return lines.reverse().slice(0, limit);
  } catch {
    return [];
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
