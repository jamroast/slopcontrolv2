import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildPlanningFailureDiagnosis,
  phaseDocAlignsWithChangeIntent,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  writeDiagnosis,
} from "./index.js";
import { extractChangeIntent } from "./change-intent.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("planning failure diagnosis", () => {
  it("buildPlanningFailureDiagnosis marks process/coding for draft Change Intent rejects", () => {
    const d = buildPlanningFailureDiagnosis({
      stage: "draft",
      title: "Draft rejected: Change Intent",
      detail:
        "Engagement Change Intent requires Automated Checks / Success Criteria that prove live AI SDK static tool-part name resolution",
      phaseId: "12-phase",
      runId: "run-1",
      kind: "change-intent",
    });
    assert.equal(d.class, "process");
    assert.equal(d.audience, "coding");
    assert.equal(d.codingAgentShouldFix, true);
    assert.match(d.fingerprint, /planning-change-intent/);
    assert.match(d.nextActions, /Retry draft/i);
    assert.ok(d.operatorActions.length > 0);
    assert.match(d.operatorActions.join(" "), /parseToolResult|tool-</i);
  });

  it("writeDiagnosis persists run + phase diagnosis for planning failures", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-plan-diag-"));
    roots.push(root);
    const diagnosis = buildPlanningFailureDiagnosis({
      stage: "draft",
      title: "Draft rejected: Change Intent",
      detail: "missing live static tool-part proof",
      phaseId: "12-chat",
      runId: "a0d93c12-test",
      kind: "change-intent",
    });
    writeDiagnosis(root, "a0d93c12-test", diagnosis, "12-chat");
    const fromRun = readDiagnosis(root, "a0d93c12-test");
    assert.ok(fromRun);
    assert.equal(fromRun!.title, "Draft rejected: Change Intent");
    assert.equal(fromRun!.phaseId, "12-chat");
    const fromPhase = readLatestDiagnosisForPhase(root, "12-chat");
    assert.ok(fromPhase);
    assert.equal(fromPhase!.fingerprint, fromRun!.fingerprint);
    const raw = JSON.parse(
      readFileSync(
        join(root, ".slopcontrol", "runs", "a0d93c12-test", "diagnosis.json"),
        "utf-8",
      ),
    ) as { class: string };
    assert.equal(raw.class, "process");
  });

  it("engagement PHASE missing Success Criteria tool-part proof still fails Change Intent gate", () => {
    const intent = extractChangeIntent(
      "Please extend the chat with dynamic form fill and submit for gathering service data",
    );
    // Force engagement-like interaction if extract is soft
    const withInteraction = {
      ...intent,
      uiMount: intent.uiMount === "n/a" ? ("page" as const) : intent.uiMount,
      interaction: intent.interaction ?? {
        mount: "page" as const,
        primaryAction: "submit form",
        proof: ["interactive control at locked mount", "primary action reachable"],
        forbiddenSubstitutes: ["summary-chip-only"],
      },
    };
    const bad = `# Phase

## Scope
Extend chat forms on the page mount.

## Success Criteria
- ThemeToggle visible
- form-bubble data-testid submit buttons present

## Automated Checks
\`\`\`bash
npm test
\`\`\`

## File Changes
- active-form.ts parseToolResult (mentioned only here)

## Blueprint Deltas
- none
`;
    const align = phaseDocAlignsWithChangeIntent(bad, withInteraction);
    assert.equal(align.ok, false);
    assert.ok(
      align.issues.some((i) => /live|tool-<|parseToolResult|extractActiveForm/i.test(i)),
      align.issues.join("; "),
    );
  });

  it("engagement PHASE with tool-part proof in Success Criteria / Checks passes", () => {
    const intent = extractChangeIntent(
      "Please extend the chat with dynamic form fill and submit for gathering service data",
    );
    const withInteraction = {
      ...intent,
      uiMount: intent.uiMount === "n/a" ? ("page" as const) : intent.uiMount,
      interaction: intent.interaction ?? {
        mount: "page" as const,
        primaryAction: "submit form",
        proof: ["interactive control at locked mount", "primary action reachable"],
        forbiddenSubstitutes: ["summary-chip-only"],
      },
    };
    const good = `# Phase

## Scope
Extend chat forms on the page mount with live AI SDK tool parts.

## Success Criteria
- composer-form / form bubbles have enabled input and submit
- extractActiveForm / parseToolResult handle type: tool-<name> without toolName

## Automated Checks
\`\`\`bash
npm test -- tests/active-form.test.ts
\`\`\`
Prove live static shape: type tool-start-workflow-draft, no toolName; parseToolResult derives name.

## Blueprint Deltas
- none
`;
    const align = phaseDocAlignsWithChangeIntent(good, withInteraction);
    assert.equal(align.ok, true, align.issues.join("; "));
  });

  it("click-to-navigate PHASE.md passes when Intent has no form contract", () => {
    const intent = extractChangeIntent(
      'Investigate why the sign-in button (UserPill) on the landing page does nothing when clicked. Wire onClick to router.push("/sign-in").',
    );
    assert.equal(intent.interaction, undefined);
    const doc = `# Phase

## Scope
Wire landing UserPill onClick to router.push("/sign-in").

## Success Criteria
- Clicking UserPill navigates to /sign-in

## Automated Checks
\`\`\`bash
grep -q 'onClick' src/components/layout/user-pill.tsx || exit 1
grep -q 'router.push("/sign-in")' src/components/layout/user-pill.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-88-USERPILL-SIGNIN:** landing UserPill navigates to /sign-in
`;
    const align = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.equal(align.ok, true, align.issues.join("; "));
  });
});
