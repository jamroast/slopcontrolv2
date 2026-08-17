import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backfillLoopStartBrief,
  liveTurnKindForTool,
} from "./live-turn-chat.js";
import { CHAT_TOOL_INPUT_SCHEMA } from "./chat-tools.js";

describe("live-turn-chat", () => {
  it("backfillLoopStartBrief uses operator message", () => {
    const out = backfillLoopStartBrief({ projectId: "p1" }, "Plan the chat UI");
    assert.equal(out.brief, "Plan the chat UI");
  });

  it("liveTurnKindForTool maps plan_loop_start", () => {
    assert.equal(liveTurnKindForTool("plan_loop_start"), "plan_loop");
  });
});

describe("plan_loop_start chat schema", () => {
  it("requires brief", () => {
    assert.throws(() =>
      CHAT_TOOL_INPUT_SCHEMA.plan_loop_start!.parse({ brief: "" }),
    );
    assert.ok(
      CHAT_TOOL_INPUT_SCHEMA.plan_loop_start!.parse({
        brief: "Investigate JamPress chat and plan components",
      }),
    );
  });
});
