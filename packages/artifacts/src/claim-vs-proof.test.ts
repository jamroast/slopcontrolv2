import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  automatedChecksHaveFiniteResolveProof,
  automatedChecksProveThemeToggleMounted,
  automatedChecksProveThemeToggleStyleVisibility,
  phaseClaimsMenubarThemeToggle,
  phaseClaimsThemeToggleVisible,
  successCriteriaClaimsModuleResolve,
  validateModuleResolveClaimProof,
  validatePhaseDocForDev,
  validateRuntimeClaimProofs,
  validateThemeShellMountClaimProof,
  validateThemeShellVisibilityClaimProof,
} from "./index.js";

function phaseDoc(opts: {
  successCriteria: string;
  checks: string[];
  scope?: string;
}): string {
  const fences = opts.checks
    .map(
      (body) => `\`\`\`bash
${body}
\`\`\``,
    )
    .join("\n\n");
  return `# Phase demo

## Scope
${opts.scope ?? "Fix styles resolve"}

## File Changes
- playground/vite.config.ts

## Success Criteria
${opts.successCriteria}

## Automated Checks

${fences}
`;
}

describe("claim-vs-proof module-resolve", () => {
  it("detects resolve claims in Success Criteria", () => {
    assert.equal(
      successCriteriaClaimsModuleResolve(
        "- [x] `pnpm playground` starts with **no** `Can't resolve '@jamroast/components/styles'` error",
      ),
      true,
    );
    assert.equal(
      successCriteriaClaimsModuleResolve("- typecheck passes"),
      false,
    );
  });

  it("detects finite resolve proofs", () => {
    assert.equal(
      automatedChecksHaveFiniteResolveProof(
        "cd playground && pnpm exec vite build || exit 1",
      ),
      true,
    );
    assert.equal(
      automatedChecksHaveFiniteResolveProof(
        "node -e \"const {createServer}=require('vite'); /* resolveId */\"",
      ),
      true,
    );
    assert.equal(
      automatedChecksHaveFiniteResolveProof(
        'grep -F "@jamroast/components/styles" playground/vite.config.ts || exit 1',
      ),
      false,
    );
  });

  it("validatePhaseDocForDev rejects resolve claims with grep-only checks", () => {
    const doc = phaseDoc({
      successCriteria:
        "- [x] playground starts with no `Can't resolve '@jamroast/components/styles'` error\n- [x] CSS loads",
      checks: [
        'grep -F "@jamroast/components/styles" playground/vite.config.ts || exit 1',
        'grep -F "../src/styles/index.css" playground/vite.config.ts || exit 1',
      ],
    });
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /finite resolve proof|vite build|resolveId/i.test(i)),
      gate.issues.join("; "),
    );
  });

  it("accepts resolve claims when vite build is present", () => {
    const doc = phaseDoc({
      successCriteria:
        "- no `Can't resolve` for `@jamroast/components/styles`\n- CSS loads",
      checks: [
        'grep -F "@jamroast/components/styles" playground/vite.config.ts || exit 1',
        "cd playground && pnpm exec vite build || exit 1",
      ],
    });
    const issues = validateRuntimeClaimProofs(doc);
    assert.deepEqual(issues, []);
    const gate = validatePhaseDocForDev(doc);
    assert.equal(
      gate.ok,
      true,
      gate.issues.join("; "),
    );
  });

  it("validateModuleResolveClaimProof is a no-op without resolve Success Criteria", () => {
    const doc = phaseDoc({
      successCriteria: "- typecheck passes\n- unit tests pass",
      checks: ["pnpm typecheck || exit 1"],
    });
    assert.deepEqual(validateModuleResolveClaimProof(doc), []);
  });
});

describe("claim-vs-proof theme-shell-mount", () => {
  it("detects menubar theme toggle claims", () => {
    assert.equal(
      phaseClaimsMenubarThemeToggle(
        "ThemeToggle is hosted inside Menubar on the playground page",
      ),
      true,
    );
    assert.equal(
      phaseClaimsMenubarThemeToggle("typecheck passes"),
      false,
    );
  });

  it("rejects export-only ThemeToggle checks for menubar claims", () => {
    const doc = phaseDoc({
      successCriteria:
        "- ThemeToggle is rendered inside Menubar on the playground kitchen sink",
      checks: [
        "grep -q 'export function ThemeToggle' src/components/shell/theme-toggle.tsx || exit 1",
        "pnpm test || exit 1",
      ],
    });
    const issues = validateThemeShellMountClaimProof(doc);
    assert.ok(issues.length > 0, "expected mount proof issues");
    assert.ok(
      issues.some((i) => /export|mount|Menubar/i.test(i)),
      issues.join("; "),
    );
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, false);
  });

  it("mount greps satisfy mount proof but not full runtime claim-vs-proof", () => {
    const doc = phaseDoc({
      successCriteria:
        "- ThemeToggle click works in Menubar on the playground page",
      checks: [
        "grep -n '<ThemeToggle' src/components/shell/menubar.tsx || exit 1",
        "grep -n '<Menubar' playground/src/App.tsx || exit 1",
        "pnpm test || exit 1",
      ],
    });
    assert.deepEqual(validateThemeShellMountClaimProof(doc), []);
    assert.equal(
      automatedChecksProveThemeToggleMounted(
        "grep -n '<ThemeToggle' src/components/shell/menubar.tsx\ngrep -n '<Menubar' playground/src/App.tsx",
      ),
      true,
    );
    // Visibility gate still fails — mounted ≠ visible
    const vis = validateThemeShellVisibilityClaimProof(doc);
    assert.ok(vis.length > 0, vis.join("; "));
  });
});

describe("claim-vs-proof theme-shell-visibility", () => {
  it("detects visible ThemeToggle claims", () => {
    assert.equal(
      phaseClaimsThemeToggleVisible(
        "ThemeToggle icons are visible on the menubar",
      ),
      true,
    );
    assert.equal(phaseClaimsThemeToggleVisible("typecheck passes"), false);
  });

  it("rejects import-order-only and mount-only checks", () => {
    const importOnly = phaseDoc({
      successCriteria:
        "- ThemeToggle is visible in Menubar on the playground with resolved utility classes",
      checks: [
        "head -n 1 playground/src/index.css | grep -q tailwindcss || exit 1",
        "grep -n '<ThemeToggle' src/components/shell/menubar.tsx || exit 1",
        "grep -n '<Menubar' playground/src/App.tsx || exit 1",
      ],
    });
    const issues = validateThemeShellVisibilityClaimProof(importOnly);
    assert.ok(issues.length > 0, "expected visibility issues");
    assert.ok(
      issues.some((i) =>
        /import order|style visibility|@source|insufficient/i.test(i),
      ),
      issues.join("; "),
    );
    assert.equal(validatePhaseDocForDev(importOnly).ok, false);
  });

  it("accepts @source covering package src", () => {
    const doc = phaseDoc({
      successCriteria:
        "- ThemeToggle is visible in Menubar on the playground page",
      checks: [
        "grep -n '<ThemeToggle' src/components/shell/menubar.tsx || exit 1",
        "grep -n '<Menubar' playground/src/App.tsx || exit 1",
        "grep -qE '@source[^;]*\\.\\./src' playground/src/index.css || exit 1",
      ],
    });
    assert.equal(
      automatedChecksProveThemeToggleStyleVisibility(
        "grep -qE '@source[^;]*../src' playground/src/index.css || exit 1",
      ),
      true,
    );
    assert.deepEqual(validateThemeShellVisibilityClaimProof(doc), []);
    assert.equal(
      validatePhaseDocForDev(doc).ok,
      true,
      validatePhaseDocForDev(doc).issues.join("; "),
    );
  });

  it("accepts vite build + dist CSS utility greps", () => {
    const doc = phaseDoc({
      successCriteria:
        "- ThemeToggle icons are visible; utilities resolve in playground CSS",
      checks: [
        "grep -n '<ThemeToggle' src/components/shell/menubar.tsx || exit 1",
        "grep -n '<Menubar' playground/src/App.tsx || exit 1",
        `cd playground && pnpm exec vite build || exit 1
CSS=$(ls dist/assets/*.css | head -1)
grep -q 'text-text-secondary' "$CSS" || exit 1
grep -qE 'h-9' "$CSS" || exit 1`,
      ],
    });
    assert.deepEqual(validateThemeShellVisibilityClaimProof(doc), []);
    assert.equal(
      validatePhaseDocForDev(doc).ok,
      true,
      validatePhaseDocForDev(doc).issues.join("; "),
    );
  });
});
