import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChatTaskDescription,
  isShortHandoffMessage,
} from "./chat-task-description.js";

describe("chat task description", () => {
  it("detects short handoff phrases", () => {
    assert.equal(isShortHandoffMessage("please hand it over"), true);
    assert.equal(isShortHandoffMessage("go ahead"), true);
    assert.equal(isShortHandoffMessage("yes"), true);
    assert.equal(
      isShortHandoffMessage(
        "## Task brief for jamroast: Service-token issuer\n\nGoal: mint JWTs",
      ),
      false,
    );
  });

  it("prefers explicit override", () => {
    const out = buildChatTaskDescription(
      [{ role: "user", content: "Original brief" }],
      { descriptionOverride: "Custom override" },
    );
    assert.equal(out, "Custom override");
  });

  it("uses substantive user message when handoff follows the brief", () => {
    const brief =
      "## Task brief for jamroast: Service-token issuer\n\nGoal: Make jamroast the central identity authority.";
    const out = buildChatTaskDescription([
      { role: "user", content: brief },
      { role: "assistant", content: "How do you want to proceed?" },
      { role: "user", content: "please hand it over" },
    ]);
    assert.equal(out, brief);
  });

  it("falls back to assistant Task brief", () => {
    const out = buildChatTaskDescription([
      { role: "user", content: "please hand it over" },
      {
        role: "assistant",
        content:
          "## Task brief\n- Title: Service-token issuer\n- Goal: Mint JWTs\n- Likely areas: auth routes\n",
      },
    ]);
    assert.match(out ?? "", /Service-token issuer/);
    assert.match(out ?? "", /Mint JWTs/);
  });

  it("returns null when only handoff phrases are present", () => {
    const out = buildChatTaskDescription([
      { role: "user", content: "yes" },
      { role: "user", content: "go ahead" },
    ]);
    assert.equal(out, null);
  });

  it("uses non-handoff operator message as last resort", () => {
    const operatorMessage =
      "Add OAuth token endpoint with JWKS and publish verifyServiceToken helper";
    const out = buildChatTaskDescription([], { operatorMessage });
    assert.equal(out, operatorMessage);
  });
});
