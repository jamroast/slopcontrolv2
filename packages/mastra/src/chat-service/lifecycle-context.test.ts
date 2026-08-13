import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGlobalChatPrompt,
  buildProjectChatPrompt,
  formatPendingConfirmPrompt,
} from "./lifecycle-context.js";
import type { ChatContextDeps } from "./types.js";
import type { Project } from "@slopcontrol/types";

const emptyDeps: ChatContextDeps = {
  listProjects: () => [],
  listPhases: () => [],
  listRuns: () => [],
  getProject: () => undefined,
};

const project: Project = {
  id: "p1",
  name: "demo",
  rootPath: "/tmp/does-not-need-to-exist",
  blueprintVersion: 0,
  createdAt: "",
  updatedAt: "",
};

describe("chat lifecycle prompt", () => {
  it("prefers ask for investigation and never sends the operator to a dashboard confirm", () => {
    const prompt = buildProjectChatPrompt({ project, deps: emptyDeps });
    assert.ok(prompt.includes("use free tools — ask"));
    assert.ok(prompt.includes("list_* / get_*"));
    assert.ok(prompt.includes("call ask — not gated agent"));
    assert.ok(prompt.includes("wait_for_run"));
    assert.ok(prompt.includes("Do not tell the operator the work finished until wait_for_run"));
    assert.ok(prompt.includes("write the operator-facing answer from that result"));
    assert.ok(prompt.includes("get_ask / get_agent"));
    assert.ok(prompt.includes("Never tell them to confirm in a separate SlopControl interface"));
    assert.ok(prompt.includes("submit_review"));
    assert.ok(prompt.includes("park advance_run"));
    assert.ok(prompt.includes("Never stop at accepted"));
    assert.ok(prompt.includes("never auto-merge"));
    assert.ok(!prompt.includes("approve in the SlopControl interface"));
    assert.ok(!prompt.includes("please do"));
    assert.ok(prompt.includes("click navigates to route X"));
    assert.ok(prompt.includes("Intent engagement is only for fill/submit"));
  });

  it("injects parked actions and forbids a separate UI confirm", () => {
    const pending = formatPendingConfirmPrompt([
      { token: "tok-1", tool: "agent", argsPreview: '{"prompt":"read landing"}' },
    ]);
    assert.ok(pending.includes("agent"));
    assert.ok(pending.includes("tok-1"));
    assert.ok(pending.includes("Never tell them to approve in a dashboard"));

    const prompt = buildGlobalChatPrompt({
      deps: emptyDeps,
      pendingActions: [{ token: "tok-1", tool: "agent" }],
    });
    assert.ok(prompt.includes("Parked gated action"));
    assert.ok(prompt.includes("agent"));
    assert.ok(prompt.includes("chat_function_bind"));
    assert.ok(!prompt.includes("chat_endpoint_model_update"));
  });
});
