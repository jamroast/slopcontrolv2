import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentSessionSchema, type AgentSession } from "@slopcontrol/types";
import {
  formatAgentTranscript,
  writeAgentArtifacts,
} from "./agent-session.js";

describe("agent session artifacts", () => {
  it("parses AgentSession schema", () => {
    const now = new Date().toISOString();
    const parsed = AgentSessionSchema.parse({
      id: "agent-1",
      projectId: "proj-1",
      title: "Verify build",
      status: "open",
      messages: [
        { role: "user", content: "Run the typecheck", at: now },
        { role: "assistant", content: "tsc exited 0", at: now },
      ],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(parsed.status, "open");
    assert.equal(parsed.messages.length, 2);
  });

  it("writes TRANSCRIPT.md and meta.json under .slopcontrol/agents", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-agent-"));
    try {
      const now = new Date().toISOString();
      const agent: AgentSession = {
        id: "agent-xyz",
        projectId: "proj-1",
        title: "Test agent",
        status: "open",
        messages: [
          { role: "user", content: "Hello", at: now },
          { role: "assistant", content: "Hi from agent", at: now },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const paths = writeAgentArtifacts(root, agent);
      assert.ok(existsSync(paths.transcript));
      assert.ok(existsSync(paths.meta));
      const md = readFileSync(paths.transcript, "utf-8");
      assert.match(md, /Test agent/);
      assert.match(md, /Hi from agent/);
      assert.match(formatAgentTranscript(agent), /User/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
