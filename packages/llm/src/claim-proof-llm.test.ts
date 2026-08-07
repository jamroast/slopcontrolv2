import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAIM_PROOF_SYSTEM_PROMPT,
  ClaimProofVerdictSchema,
  parseClaimProofVerdictPayload,
} from "./claim-proof-llm.js";

describe("claim-proof-llm", () => {
  it("system prompt carries the export-only and import-order-only rules", () => {
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /Export-only/);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /export function ThemeToggle/);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /Import-order-only/);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /@import "tailwindcss"/);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /Mounted ≠ visible/);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /Long-lived dev servers/);
  });

  it("system prompt allows proofs in a different form and fails closed", () => {
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /DIFFERENT FORM/);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /fail closed/i);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /genuineGap=true/);
    assert.match(CLAIM_PROOF_SYSTEM_PROMPT, /genuineGap=false/);
  });

  it("parses a genuine-gap verdict with a suggested check", () => {
    const verdict = ClaimProofVerdictSchema.parse({
      genuineGap: true,
      reason: "Checks only grep export function ThemeToggle; no mount proof.",
      suggestedCheck: "grep -r '<ThemeToggle' src/components/shell/menubar.tsx || exit 1",
    });
    assert.equal(verdict.genuineGap, true);
    assert.match(verdict.suggestedCheck ?? "", /<ThemeToggle/);
  });

  it("parses a rejected-gap verdict with existing proof", () => {
    const verdict = parseClaimProofVerdictPayload({
      genuineGap: false,
      reason: "vitest render test mounts Menubar with ThemeToggle.",
      existingProof: "pnpm exec vitest run src/shell/menubar.test.tsx",
    });
    assert.equal(verdict.genuineGap, false);
    assert.match(verdict.existingProof ?? "", /vitest/);
  });

  it("fails closed on a messy payload", () => {
    const verdict = parseClaimProofVerdictPayload("garbage");
    assert.equal(verdict.genuineGap, true);
    assert.match(verdict.reason, /no reason/i);

    const missing = parseClaimProofVerdictPayload({ reason: "unsure" });
    assert.equal(missing.genuineGap, true);
  });

  it("drops blank optional fields", () => {
    const verdict = parseClaimProofVerdictPayload({
      genuineGap: true,
      reason: "gap is real",
      existingProof: "   ",
      suggestedCheck: "",
    });
    assert.equal(verdict.existingProof, undefined);
    assert.equal(verdict.suggestedCheck, undefined);
  });
});
