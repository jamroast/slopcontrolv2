/**
 * Ask-parity chat for design-loop and plan-loop.
 * CHAT.json is structured messages; TRANSCRIPT.md stays human-readable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LoopChatRole = "user" | "assistant";

export type LoopChatMessageMeta = {
  kind?: "working" | "final" | "system";
  version?: number;
  assets?: string[];
  ops?: string[];
};

export type LoopChatMessage = {
  role: LoopChatRole;
  content: string;
  at: string;
  meta?: LoopChatMessageMeta;
};

export type LoopChatKind = "design" | "plan";

function loopDir(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
): string {
  const folder = kind === "design" ? "design-loops" : "plan-loops";
  return join(projectRoot, ".slopcontrol", folder, loopId);
}

export function loopChatPath(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
): string {
  return join(loopDir(projectRoot, kind, loopId), "CHAT.json");
}

export function loopTranscriptPath(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
): string {
  return join(loopDir(projectRoot, kind, loopId), "TRANSCRIPT.md");
}

function ensureLoopDir(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
): void {
  mkdirSync(loopDir(projectRoot, kind, loopId), { recursive: true });
}

export function readLoopChatMessages(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
): LoopChatMessage[] {
  const path = loopChatPath(projectRoot, kind, loopId);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      messages?: LoopChatMessage[];
    };
    return Array.isArray(raw.messages) ? raw.messages : [];
  } catch {
    return [];
  }
}

function writeChatJson(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
  messages: LoopChatMessage[],
): void {
  ensureLoopDir(projectRoot, kind, loopId);
  writeFileSync(
    loopChatPath(projectRoot, kind, loopId),
    `${JSON.stringify({ messages }, null, 2)}\n`,
    "utf-8",
  );
}

function formatTranscript(
  kind: LoopChatKind,
  loopId: string,
  messages: LoopChatMessage[],
): string {
  const title = kind === "design" ? "Design loop" : "Plan loop";
  const lines = [`# ${title} — ${loopId}`, "", "## Transcript", ""];
  for (const m of messages) {
    const label = m.role === "user" ? "User" : "Assistant";
    lines.push(`### ${label} (${m.at})`, "", m.content.trim(), "");
  }
  return lines.join("\n");
}

function writeTranscriptMd(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
  messages: LoopChatMessage[],
): void {
  ensureLoopDir(projectRoot, kind, loopId);
  writeFileSync(
    loopTranscriptPath(projectRoot, kind, loopId),
    formatTranscript(kind, loopId, messages),
    "utf-8",
  );
}

export function writeLoopChatArtifacts(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
  messages: LoopChatMessage[],
): void {
  writeChatJson(projectRoot, kind, loopId, messages);
  writeTranscriptMd(projectRoot, kind, loopId, messages);
}

export function appendLoopChatMessage(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
  message: Omit<LoopChatMessage, "at"> & { at?: string },
): LoopChatMessage[] {
  const messages = readLoopChatMessages(projectRoot, kind, loopId);
  const next: LoopChatMessage = {
    role: message.role,
    content: message.content,
    at: message.at ?? new Date().toISOString(),
    ...(message.meta ? { meta: message.meta } : {}),
  };
  messages.push(next);
  writeLoopChatArtifacts(projectRoot, kind, loopId, messages);
  return messages;
}

export function replaceLastAssistantLoopChatMessage(
  projectRoot: string,
  kind: LoopChatKind,
  loopId: string,
  content: string,
  opts?: { at?: string; meta?: LoopChatMessageMeta },
): LoopChatMessage[] {
  const messages = readLoopChatMessages(projectRoot, kind, loopId);
  const at = opts?.at ?? new Date().toISOString();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      messages[i] = {
        role: "assistant",
        content,
        at,
        ...(opts?.meta ? { meta: opts.meta } : messages[i]!.meta
          ? { meta: messages[i]!.meta }
          : {}),
      };
      writeLoopChatArtifacts(projectRoot, kind, loopId, messages);
      return messages;
    }
  }
  messages.push({
    role: "assistant",
    content,
    at,
    ...(opts?.meta ? { meta: opts.meta } : {}),
  });
  writeLoopChatArtifacts(projectRoot, kind, loopId, messages);
  return messages;
}

export function formatLoopWorkingStub(
  lines: string[],
  opts?: { startedAt?: string },
): string {
  const started = opts?.startedAt ?? new Date().toISOString();
  const body = lines.filter(Boolean).slice(-12).join("\n");
  return `Working…\n\n_started ${started}_\n\n${body || "(in progress)"}`;
}
