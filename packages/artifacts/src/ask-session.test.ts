import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AskSessionSchema,
  type AskSession,
} from "@slopcontrol/types";
import {
  ASK_TIMEOUT_RECOVERY_MESSAGE,
  buildAskTaskDescription,
  extractLastTaskBrief,
  formatAskTranscript,
  isAskAgentTimeoutError,
  writeAskArtifacts,
} from "./ask-session.js";

describe("ask session artifacts", () => {
  it("parses AskSession schema", () => {
    const now = new Date().toISOString();
    const parsed = AskSessionSchema.parse({
      id: "ask-1",
      projectId: "proj-1",
      title: "Connectors?",
      status: "open",
      messages: [
        { role: "user", content: "How do connectors work?", at: now },
        { role: "assistant", content: "They live in src/lib/…", at: now },
      ],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(parsed.status, "open");
    assert.equal(parsed.messages.length, 2);
  });

  it("extracts last Task brief from assistant messages", () => {
    const brief = extractLastTaskBrief([
      {
        role: "user",
        content: "I want Google connectors",
        at: "2026-01-01T00:00:00.000Z",
      },
      {
        role: "assistant",
        content: `Sure.

## Task brief
- Title: Add Google OAuth connectors
- Goal: Persist tokens and expose tools
- Out of scope: Slack

More chatter.`,
        at: "2026-01-01T00:01:00.000Z",
      },
    ]);
    assert.ok(brief);
    assert.match(brief!, /Google OAuth connectors/);
    assert.match(brief!, /Persist tokens/);
  });

  it("buildAskTaskDescription prefers override then operator request over Task brief", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const ask: AskSession = {
      id: "ask-1",
      projectId: "proj-1",
      status: "open",
      messages: [
        {
          role: "user",
          content: "Move the form into the chat prompt / composer",
          at: now,
        },
        {
          role: "assistant",
          content:
            "## Task brief\n- Title: Dark mode toggle\n- Goal: Theme switch\n- Likely areas: form-bubble.tsx\n",
          at: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    assert.equal(
      buildAskTaskDescription(ask, { descriptionOverride: "Custom brief" }),
      "Custom brief",
    );
    const fromAsk = buildAskTaskDescription(ask);
    assert.match(fromAsk, /Operator request/);
    assert.match(fromAsk, /chat prompt \/ composer/);
    assert.match(fromAsk, /Proposed approach \(non-binding/);
    assert.match(fromAsk, /Dark mode toggle/);
  });

  it("falls back to first user message when no Task brief", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const ask: AskSession = {
      id: "ask-2",
      projectId: "proj-1",
      title: "Env question",
      status: "open",
      messages: [
        { role: "user", content: "Where is DATABASE_URL set?", at: now },
        { role: "assistant", content: "In .env.docker", at: now },
      ],
      createdAt: now,
      updatedAt: now,
    };
    const desc = buildAskTaskDescription(ask);
    assert.match(desc, /Env question|DATABASE_URL/);
    assert.match(desc, /\*\*user:\*\*/);
  });

  it("writes TRANSCRIPT.md and meta.json under .slopcontrol/asks", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-ask-"));
    try {
      const now = new Date().toISOString();
      const ask: AskSession = {
        id: "ask-abc",
        projectId: "proj-1",
        title: "Test ask",
        status: "open",
        messages: [
          { role: "user", content: "Hello", at: now },
          { role: "assistant", content: "Hi there", at: now },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const paths = writeAskArtifacts(root, ask);
      assert.ok(existsSync(paths.transcript));
      assert.ok(existsSync(paths.meta));
      const md = readFileSync(paths.transcript, "utf-8");
      assert.match(md, /Test ask/);
      assert.match(md, /Hi there/);
      assert.match(formatAskTranscript(ask), /User/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects ask agent timeout errors and exposes recovery copy", () => {
    assert.equal(
      isAskAgentTimeoutError(
        new Error("Agent Ask timed out after 180000ms"),
      ),
      true,
    );
    assert.equal(isAskAgentTimeoutError(new Error("boom")), false);
    assert.match(ASK_TIMEOUT_RECOVERY_MESSAGE, /Ask timed out/i);
    assert.match(ASK_TIMEOUT_RECOVERY_MESSAGE, /narrower question/i);
  });
});
