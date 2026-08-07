import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  appendLoopChatMessage,
  readLoopChatMessages,
  replaceLastAssistantLoopChatMessage,
  writeLoopChatArtifacts,
} from "./loop-chat.js";

describe("loop-chat", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("appends and replaces assistant working stub", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-loop-chat-"));
    roots.push(root);
    const loopId = "loop-1";
    appendLoopChatMessage(root, "design", loopId, {
      role: "user",
      content: "cut out the circular logo",
    });
    appendLoopChatMessage(root, "design", loopId, {
      role: "assistant",
      content: "Working…",
      meta: { kind: "working" },
    });
    replaceLastAssistantLoopChatMessage(
      root,
      "design",
      loopId,
      "Applied circular cut-out to logo-alpha.png.",
      { meta: { kind: "final", version: 13, ops: ["circular_mask"] } },
    );
    const messages = readLoopChatMessages(root, "design", loopId);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[1]!.role, "assistant");
    assert.match(messages[1]!.content, /circular cut-out/i);
    assert.equal(messages[1]!.meta?.kind, "final");
  });

  it("plan chat writes CHAT.json", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-plan-chat-"));
    roots.push(root);
    writeLoopChatArtifacts(root, "plan", "p1", [
      {
        role: "user",
        content: "narrow the goal",
        at: new Date().toISOString(),
      },
    ]);
    assert.equal(readLoopChatMessages(root, "plan", "p1").length, 1);
  });
});
