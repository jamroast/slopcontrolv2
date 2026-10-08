---
name: slopcontrol-diagnose
description: Diagnose and fix SlopControl failures via the classify -> investigate -> review -> bounded-execute pipeline. Use when a SlopControl run fails, a test is red, or the harness misbehaves, instead of hardcoding a per-case fix.
---

# SlopControl diagnose → fix

Fix the **pipeline**, not the errno. Resolve every failure through the full loop; never a per-instance/deterministic hardcoded patch.

## 1. Classify

From the **first failing step** (not truncated whole-run noise), classify into one of:

- `infra` — connection refused, services down, missing secrets, `verifyPreflightCommand` failure
- `product` — a real bug in SlopControl's own code
- `process` — harness orchestration / prompt / routing
- `model` — LLM output broken, classifier failed, judge missing/error
- `env` — keys/quota/config

The classification decides the next move. `infra`/`env` mean restore reality, not patch code. `model` means fallback routing / timeout tuning / judge, never a regex fallback.

## 2. Investigate

Read the actual code paths and run **read-only** probes before touching anything:

- Find the failing stage/package (`packages/<pkg>/src`, `apps/<app>/src`).
- Inspect the relevant `.slopcontrol/runs/<runId>/` artifacts (`log.txt`, `checks/`, `diagnosis.json`) and phase docs when relevant.
- Reproduce minimally; confirm the root cause with evidence (exact file/line), not a guess.

Use fixtures under `packages/artifacts/fixtures/` for Intent/Blueprint/UI-gate smoke repros.

## 3. Review

- Re-check against `AGENTS.md` rules: no regex for judgment/intent, generic code (no hardcoded project identifiers), fail-closed classifiers.
- Prefer self-healing/generic fixes. Only modify `slopconrolV2/` — never hand-edit managed projects (those go through SlopControl runs).

## 4. Bounded execute

- Make the smallest change that fixes the *mechanism*, not the symptom.
- Verify via `pnpm typecheck` + targeted `pnpm --filter <pkg> test`.
- For Cursor/handoff reviews: independently verify each claim; handle **one numbered finding at a time**, verify, report, await instruction.

## Ship

When verified, commit and push (`/skill:slopcontrol-verify` covers the mechanics).

## When it keeps failing

- The same diagnosis fingerprint repeating 3× should **block** rather than loop — surface it to the operator with evidence.
- On transient LLM/network errors, retry before concluding a real bug.
