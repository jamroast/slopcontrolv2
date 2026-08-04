import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatAntiAuditThemeDeliveryNote,
  operatorRequestsMissingThemeControl,
  phaseDocDeclaresReviewOnlyNoFileChanges,
  phaseDocRejectsMissingThemeAudit,
} from "./design-delivery.js";

describe("design-delivery anti-audit", () => {
  it("detects missing/add theme control language", () => {
    assert.equal(
      operatorRequestsMissingThemeControl(
        "Can you please investigate why the day and night mode button is not appearing on the menu bar",
      ),
      true,
    );
    assert.equal(
      operatorRequestsMissingThemeControl(
        "Audit the existing light/dark theme toggle wiring",
      ),
      false,
    );
  });

  it("detects review-only File Changes", () => {
    const doc = `# Phase 08

## Scope
Review only

## File Changes
**No file changes are required.** All theme infrastructure was delivered in Phase 05.

## Success Criteria
- verified

## Automated Checks
\`\`\`bash
true
\`\`\`
`;
    assert.equal(phaseDocDeclaresReviewOnlyNoFileChanges(doc), true);
  });

  it("rejects review-only when operator missing + design toggle present", () => {
    const phaseDoc = `# Phase 08

## Scope
This is a **review-only** phase.

## File Changes
**No file changes are required.**

## Success Criteria
- ok

## Automated Checks
\`\`\`bash
true
\`\`\`
`;
    const result = phaseDocRejectsMissingThemeAudit({
      description:
        "day and night mode button is not appearing on the menubar in the playground",
      phaseDoc,
      togglePresent: true,
      designShellOrThemeAccepted: true,
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => /review-only|No file changes/i.test(i)));
  });

  it("allows review-only when no missing language", () => {
    const result = phaseDocRejectsMissingThemeAudit({
      description: "Audit existing theme toggle wiring only",
      phaseDoc: "review-only. No file changes are required.",
      togglePresent: true,
    });
    assert.equal(result.ok, true);
  });

  it("formats delivery note for missing + bound toggle", () => {
    const note = formatAntiAuditThemeDeliveryNote({
      description: "add the day/night ThemeToggle to the menubar",
      togglePresent: true,
    });
    assert.match(note, /Do NOT close as review-only/i);
    assert.match(note, /ThemeToggle/i);
    assert.match(note, /@source|style emission|built.*css/i);
  });

  it("anti-audit issue requires style/@source proof not mount alone", () => {
    const phaseDoc = `# Phase 08

## Scope
This is a **review-only** phase.

## File Changes
**No file changes are required.**

## Success Criteria
- ok

## Automated Checks
\`\`\`bash
true
\`\`\`
`;
    const result = phaseDocRejectsMissingThemeAudit({
      description:
        "day and night mode button is not appearing on the menubar in the playground",
      phaseDoc,
      togglePresent: true,
      designShellOrThemeAccepted: true,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((i) => /@source|style visibility|built CSS/i.test(i)),
      result.issues.join("; "),
    );
  });
});
