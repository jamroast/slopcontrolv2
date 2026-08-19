import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recoverInvestigateWithRetry } from "./verify-recovery.js";
import type { RecoveryExecutePayload } from "@slopcontrol/artifacts";

const PAYLOAD: RecoveryExecutePayload = {
  confidence: "high",
  rationale: "stale node_modules",
  execute: "rm -rf node_modules && npm ci",
} as RecoveryExecutePayload;

function ok(payload: RecoveryExecutePayload | null, dirtyWarning: string | null = null) {
  return { payload, output: "out", dirtyWarning };
}

describe("recoverInvestigateWithRetry", () => {
  it("returns immediately on a payload without retrying", async () => {
    let calls = 0;
    const result = await recoverInvestigateWithRetry(async () => {
      calls++;
      return ok(PAYLOAD);
    });
    assert.equal(calls, 1);
    assert.equal(result.payload, PAYLOAD);
  });

  it("treats a dirty tree as terminal (no retry)", async () => {
    let calls = 0;
    const result = await recoverInvestigateWithRetry(async () => {
      calls++;
      return ok(null, "investigator modified files: src/x.ts");
    });
    assert.equal(calls, 1);
    assert.ok(result.dirtyWarning);
  });

  it("retries once on throw and succeeds with a retry note", async () => {
    let calls = 0;
    const notes: Array<string | undefined> = [];
    const result = await recoverInvestigateWithRetry(async (note) => {
      calls++;
      notes.push(note);
      if (calls === 1) throw new Error("session_error: stream aborted");
      return ok(PAYLOAD);
    });
    assert.equal(calls, 2);
    assert.equal(notes[0], undefined);
    assert.match(notes[1] ?? "", /Prior attempt died on a session error/);
    assert.equal(result.payload, PAYLOAD);
  });

  it("retries once on empty payload", async () => {
    let calls = 0;
    const result = await recoverInvestigateWithRetry(async () => {
      calls++;
      return calls === 1 ? ok(null) : ok(PAYLOAD);
    });
    assert.equal(calls, 2);
    assert.equal(result.payload, PAYLOAD);
  });

  it("throws with the last failure reason after both attempts throw", async () => {
    let calls = 0;
    await assert.rejects(
      recoverInvestigateWithRetry(async () => {
        calls++;
        throw new Error(`session_error attempt ${calls}`);
      }),
      /failed after 2 attempts: session_error attempt 2/,
    );
    assert.equal(calls, 2);
  });

  it("throws after both attempts return empty payloads", async () => {
    let calls = 0;
    await assert.rejects(
      recoverInvestigateWithRetry(async () => {
        calls++;
        return ok(null);
      }),
      /failed after 2 attempts: investigator emitted no RECOVERY_EXECUTE JSON/,
    );
    assert.equal(calls, 2);
  });
});
