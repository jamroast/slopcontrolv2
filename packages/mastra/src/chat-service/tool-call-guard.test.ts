import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolCallGuard } from "./tool-call-guard.js";
import { formatRunNotificationBrief } from "./run-settled-notification.js";

describe("formatRunNotificationBrief", () => {
  it("strips bracket wrapper from system notifications", () => {
    const brief = formatRunNotificationBrief(
      "[Run run-1 reached complete. Development finished successfully.]",
    );
    assert.equal(brief, "Run run-1 reached complete. Development finished successfully.");
  });
});

describe("createToolCallGuard", () => {
  it("blocks a third identical read-only tool call in one turn", () => {
    const guard = createToolCallGuard();
    const args = { runId: "r1" };
    assert.equal(guard.check("get_run", args), null);
    assert.equal(guard.check("get_run", args), null);
    assert.match(
      guard.check("get_run", args) ?? "",
      /disabled for this turn/,
    );
  });

  it("does not guard mutating or conversational tools", () => {
    const guard = createToolCallGuard();
    const args = { message: "hi" };
    assert.equal(guard.check("ask", args), null);
    assert.equal(guard.check("ask", args), null);
    assert.equal(guard.check("ask", args), null);
  });
});
