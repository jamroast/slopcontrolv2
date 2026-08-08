import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskMessage, AskSession } from "@slopcontrol/types";

const SLOP_DIR = ".slopcontrol";

function slopRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR);
}

export function asksRoot(projectRoot: string): string {
  return join(slopRoot(projectRoot), "asks");
}

export function askDir(projectRoot: string, askId: string): string {
  return join(asksRoot(projectRoot), askId);
}

export function ensureAskDir(projectRoot: string, askId: string): string {
  mkdirSync(slopRoot(projectRoot), { recursive: true });
  const dir = askDir(projectRoot, askId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function askTranscriptPath(projectRoot: string, askId: string): string {
  return join(askDir(projectRoot, askId), "TRANSCRIPT.md");
}

export function askMetaPath(projectRoot: string, askId: string): string {
  return join(askDir(projectRoot, askId), "meta.json");
}

export function formatAskTranscript(ask: AskSession): string {
  const lines = [
    `# Ask — ${ask.title?.trim() || ask.id}`,
    "",
    `- **id:** ${ask.id}`,
    `- **status:** ${ask.status}`,
    `- **updated:** ${ask.updatedAt}`,
  ];
  if (ask.promotedPhaseId) {
    lines.push(`- **promotedPhaseId:** ${ask.promotedPhaseId}`);
  }
  lines.push("", "## Transcript", "");
  for (const m of ask.messages) {
    const label = m.role === "user" ? "User" : "Assistant";
    lines.push(`### ${label} (${m.at})`, "", m.content.trim(), "");
  }
  return lines.join("\n");
}

/** Persist human-readable transcript + meta under `.slopcontrol/asks/<id>/`. */
export function writeAskArtifacts(
  projectRoot: string,
  ask: AskSession,
): { transcript: string; meta: string } {
  ensureAskDir(projectRoot, ask.id);
  const transcript = askTranscriptPath(projectRoot, ask.id);
  const meta = askMetaPath(projectRoot, ask.id);
  writeFileSync(transcript, formatAskTranscript(ask), "utf-8");
  writeFileSync(
    meta,
    JSON.stringify(
      {
        id: ask.id,
        projectId: ask.projectId,
        title: ask.title,
        status: ask.status,
        promotedPhaseId: ask.promotedPhaseId,
        messageCount: ask.messages.length,
        createdAt: ask.createdAt,
        updatedAt: ask.updatedAt,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  return { transcript, meta };
}

/** True when askTurn / runAgent rejected with the Ask agent wall-clock timeout. */
export function isAskAgentTimeoutError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /Agent\s+Ask\s+timed\s+out\s+after/i.test(msg);
}

export const ASK_TIMEOUT_RECOVERY_MESSAGE = `Ask timed out before a complete answer.

Retry with a narrower question (e.g. which file hosts ThemeToggle / Menubar), or promote_ask with a ## Task brief when you already know the change. For several probes, use ask_sub_research (max 4 topics).`;

export function readAskMeta(
  projectRoot: string,
  askId: string,
): Record<string, unknown> | null {
  const path = askMetaPath(projectRoot, askId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Build a phase description for promote_ask.
 * Prefers an explicit override, then the **latest operator (user) message** —
 * continued ask sessions often shift topic, and concatenating every user
 * message buries the current request under stale ones (earlier context still
 * rides along in the transcript excerpt). The ask agent's latest Task brief is
 * appended as a non-binding proposed approach.
 */
export function buildAskTaskDescription(
  ask: AskSession,
  opts?: { descriptionOverride?: string; maxChars?: number },
): string {
  const override = opts?.descriptionOverride?.trim();
  if (override) return override.slice(0, opts?.maxChars ?? 8_000);

  const maxChars = opts?.maxChars ?? 8_000;
  const lastUserMessage = [...ask.messages]
    .reverse()
    .find((m) => m.role === "user")
    ?.content.trim();
  const operatorBlock = lastUserMessage
    ? ["## Operator request", "", lastUserMessage].join("\n\n")
    : null;

  const brief = extractLastTaskBrief(ask.messages);
  const proposed = brief
    ? [
        "### Proposed approach (non-binding — from ask agent; prefer Operator request for placement/UI mount)",
        "",
        brief,
      ].join("\n")
    : null;

  if (operatorBlock) {
    return [operatorBlock, proposed, "", "### Ask conversation context", "", formatTranscriptExcerpt(ask.messages, 2_000)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, maxChars);
  }

  if (brief) {
    return [
      brief,
      "",
      "---",
      "",
      "### Ask conversation context",
      "",
      formatTranscriptExcerpt(ask.messages, 3_000),
    ]
      .join("\n")
      .slice(0, maxChars);
  }

  const firstUser = ask.messages.find((m) => m.role === "user")?.content.trim();
  const title = ask.title?.trim() || firstUser?.slice(0, 120) || `Ask ${ask.id}`;
  return [
    title,
    "",
    "### Ask conversation context",
    "",
    formatTranscriptExcerpt(ask.messages, 4_000),
  ]
    .join("\n")
    .slice(0, maxChars);
}

export function extractLastTaskBrief(messages: AskMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const section = extractMarkdownSection(m.content, /Task\s+brief/i);
    if (section?.trim()) {
      const titleLine =
        section
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("-")) ??
        null;
      const header = titleLine ? `## ${titleLine}\n\n` : "## Task brief\n\n";
      return `${header}${section.trim()}`;
    }
  }
  return null;
}

function extractMarkdownSection(
  markdown: string,
  heading: RegExp,
): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  let level = 2;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+)$/.exec(lines[i] ?? "");
    if (!m) continue;
    if (heading.test(m[2] ?? "")) {
      start = i + 1;
      level = m[1]!.length;
      break;
    }
  }
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+/.exec(lines[i] ?? "");
    if (m && m[1]!.length <= level) break;
    body.push(lines[i] ?? "");
  }
  return body.join("\n").trim() || null;
}

function formatTranscriptExcerpt(
  messages: AskMessage[],
  maxChars: number,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const m of messages) {
    const block = `**${m.role}:** ${m.content.trim()}`;
    if (used + block.length + 2 > maxChars) {
      parts.push("…[transcript truncated]");
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join("\n\n");
}
