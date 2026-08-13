import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isReviewRequiredConflict,
  retryAfterImpliedReviewApprove,
} from "./mcp-tools.js";

describe("in_review start_development conflict", () => {
  const conflictBody = JSON.stringify({
    error: "Phase must be accepted or design_complete before development can start",
    stage: "in_review",
    phaseStatus: "in_review",
  });

  it("detects the in_review 409 that blocked chat start_development", () => {
    assert.equal(isReviewRequiredConflict(409, conflictBody), true);
    assert.equal(isReviewRequiredConflict(202, conflictBody), false);
    assert.equal(
      isReviewRequiredConflict(
        409,
        JSON.stringify({ error: "design_required", stage: "accepted" }),
      ),
      false,
    );
    assert.equal(
      isReviewRequiredConflict(
        409,
        JSON.stringify({
          error: "development_in_progress",
          stage: "developing",
        }),
      ),
      false,
    );
  });

  it("approves review then retries start_development", async () => {
    const calls: string[] = [];
    const result = await retryAfterImpliedReviewApprove({
      firstStatus: 409,
      firstBody: conflictBody,
      approve: async () => {
        calls.push("approve");
        return { status: 200, body: JSON.stringify({ stage: "accepted" }) };
      },
      retry: async () => {
        calls.push("retry");
        return { status: 202, body: JSON.stringify({ stage: "developing" }) };
      },
    });
    assert.deepEqual(calls, ["approve", "retry"]);
    assert.equal(result.status, 202);
    assert.match(result.body, /developing/);
  });

  it("does not approve when the first call was not an in_review gate", async () => {
    let approved = false;
    const first = {
      status: 409,
      body: JSON.stringify({ error: "design_required" }),
    };
    const result = await retryAfterImpliedReviewApprove({
      firstStatus: first.status,
      firstBody: first.body,
      approve: async () => {
        approved = true;
        return { status: 200, body: "{}" };
      },
      retry: async () => ({ status: 202, body: "{}" }),
    });
    assert.equal(approved, false);
    assert.equal(result.status, 409);
    assert.equal(result.body, first.body);
  });

  it("returns the approve error and does not retry", async () => {
    const result = await retryAfterImpliedReviewApprove({
      firstStatus: 409,
      firstBody: conflictBody,
      approve: async () => ({
        status: 409,
        body: JSON.stringify({ error: "Cannot approve: PHASE.md failed" }),
      }),
      retry: async () => {
        throw new Error("should not retry");
      },
    });
    assert.equal(result.status, 409);
    assert.match(result.body, /Cannot approve/);
  });
});
