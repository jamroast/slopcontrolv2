import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  askProgressFromStreamChunk,
  askProgressLine,
  clipAskProgress,
  formatAskWorkingStub,
  isAskNarrationOnlyReply,
  isLiveTurnInterruptedError,
  LiveTurnInterruptedError,
  summarizeToolArgs,
  summarizeToolResult,
} from "./ask-stream.js";

describe("ask-stream helpers", () => {
  it("summarizes tool args and results", () => {
    assert.match(
      summarizeToolArgs("grep_files", {
        path: "playground",
        pattern: "@source",
      }),
      /grep_files.*path=playground.*pattern=@source/,
    );
    assert.equal(
      summarizeToolResult("grep_files", { matches: [1, 2], count: 2 }),
      "grep_files → 2 match(es)",
    );
    assert.match(
      summarizeToolResult("read_file", { content: "a\nb\nc", lines: 3 }),
      /3 line/,
    );
  });

  it("maps stream chunks to progress events", () => {
    const call = askProgressFromStreamChunk({
      type: "tool-call",
      payload: {
        toolName: "read_file",
        args: { path: "src/menubar.tsx" },
      },
    });
    assert.equal(call[0]?.type, "tool_call");
    assert.match(String(call[0] && "summary" in call[0] ? call[0].summary : ""), /read_file/);

    const result = askProgressFromStreamChunk({
      type: "tool-result",
      payload: {
        toolName: "read_file",
        result: { content: "x", lines: 1 },
      },
    });
    assert.equal(result[0]?.type, "tool_result");

    const text = askProgressFromStreamChunk({
      type: "text-delta",
      payload: { text: "Hello" },
    });
    assert.deepEqual(text, [{ type: "text", text: "Hello" }]);
  });

  it("detects narration-only replies for synthesis", () => {
    assert.equal(isAskNarrationOnlyReply(""), true);
    assert.equal(
      isAskNarrationOnlyReply(
        "Let me investigate both issues.I'll start by exploring.Now let me check the styles:",
      ),
      true,
    );
    assert.equal(
      isAskNarrationOnlyReply(
        "## Root cause\n\nThemeToggle is mounted in `menubar.tsx` but playground CSS lacks `@source`.\n\n## Task brief\n- Title: Fix visibility\n- Goal: emit utilities",
      ),
      false,
    );
  });

  it("exports LiveTurnInterruptedError", () => {
    const err = new LiveTurnInterruptedError("Live turn interrupted", "partial");
    assert.equal(isLiveTurnInterruptedError(err), true);
    assert.equal(err.partialReply, "partial");
  });

  it("formats working stub and progress lines", () => {
    assert.equal(clipAskProgress("abc", 10), "abc");
    assert.match(clipAskProgress("a".repeat(200), 20), /…$/);
    const stub = formatAskWorkingStub([
      "grep_files @source",
      "read_file menubar.tsx",
    ]);
    assert.match(stub, /Working…/);
    assert.match(stub, /grep_files/);
    assert.equal(
      askProgressLine({
        type: "tool_call",
        tool: "x",
        summary: "read_file path=a",
      }),
      "read_file path=a",
    );
    assert.equal(askProgressLine({ type: "text", text: "hi" }), null);
  });
});
