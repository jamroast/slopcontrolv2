import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  automatedChecksHaveFiniteResolveProof,
  automatedChecksProveContentAlignedMenubar,
  automatedChecksProveFullWidthMenubar,
  automatedChecksProveThemeToggleMounted,
  automatedChecksProveThemeToggleStyleVisibility,
  formatClaimProofChecksGuidance,
  phaseClaimsContentAlignedMenubar,
  phaseClaimsFullWidthMenubar,
  phaseClaimsMenubarThemeToggle,
  phaseClaimsThemeToggleVisible,
  successCriteriaClaimsModuleResolve,
  validateModuleResolveClaimProof,
  validatePhaseDocForDev,
  validateRuntimeClaimProofs,
  validateRuntimeClaimProofsAsync,
  validateShellContentWidthClaimProof,
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

describe("claim-vs-proof shell content-width layout", () => {
  it("detects content-aligned menubar claims", () => {
    assert.equal(
      phaseClaimsContentAlignedMenubar(
        "Centre the menubar over landing content at --content-max",
      ),
      true,
    );
    assert.equal(
      phaseClaimsContentAlignedMenubar("Add ViewSwitcher prop to Menubar"),
      false,
    );
  });

  it("rejects ViewSwitcher-only checks when PHASE claims content-aligned menubar", () => {
    const doc = phaseDoc({
      scope:
        "Centre the menubar over page content at the same --content-max width",
      successCriteria:
        "- Menubar inner bar matches page content width; ViewSwitcher optional",
      checks: [
        "grep -n 'viewSwitcher' src/components/shell/menubar.tsx || exit 1",
        "grep -n 'activeView' playground/src/App.tsx || exit 1",
        "pnpm test || exit 1",
      ],
    });
    const issues = validateShellContentWidthClaimProof(doc);
    assert.ok(issues.length > 0, "expected content-max proof issues");
    assert.ok(
      issues.some((i) => /content-max|ViewSwitcher/i.test(i)),
      issues.join("; "),
    );
    assert.equal(validatePhaseDocForDev(doc).ok, false);
  });

  it("accepts content-max menubar + playground mount greps", () => {
    const doc = phaseDoc({
      scope: "Align menubar with page content width (content-max inner bar)",
      successCriteria:
        "- Menubar uses max-width: var(--content-max) inner wrapper matching ShellContent",
      checks: [
        "grep -n '--content-max' src/components/shell/menubar.tsx || exit 1",
        "grep -n 'menubar__inner\\|maxWidth' src/components/shell/menubar.tsx || exit 1",
        "grep -n '<Menubar' playground/src/App.tsx || exit 1",
        "pnpm test || exit 1",
      ],
    });
    assert.equal(
      automatedChecksProveContentAlignedMenubar(
        "grep -n '--content-max' src/components/shell/menubar.tsx\ngrep -n '<Menubar' playground/src/App.tsx",
      ),
      true,
    );
    assert.deepEqual(validateShellContentWidthClaimProof(doc), []);
    assert.equal(
      validatePhaseDocForDev(doc).ok,
      true,
      validatePhaseDocForDev(doc).issues.join("; "),
    );
  });

  it("detects full-width menubar intent", () => {
    assert.equal(
      phaseClaimsFullWidthMenubar(
        "Make the menubar full-width, edge to edge across the viewport",
      ),
      true,
    );
    assert.equal(
      phaseClaimsFullWidthMenubar("Menubar should be full screen"),
      true,
    );
    assert.equal(
      phaseClaimsFullWidthMenubar(
        "Remove the --content-max inner wrapper from the menubar",
      ),
      true,
    );
    assert.equal(
      phaseClaimsFullWidthMenubar(
        "Centre the menubar over page content at --content-max",
      ),
      false,
    );
    assert.equal(phaseClaimsFullWidthMenubar("Add ViewSwitcher prop"), false);
  });

  it("full-width intent: accepts negative-proof checks (JamLight phase 33 regression)", () => {
    // The run that looped 1350x: full-width ask, validator demanded the very
    // tokens the change removes. Negative greps + w-full + mount must pass.
    const doc = phaseDoc({
      scope: "Make the dashboard menubar full-width (no --content-max constraint)",
      successCriteria:
        "- Menubar spans the full viewport width; content-max wrapper removed",
      checks: [
        "! grep -q 'var(--content-max)' src/components/jamlight-menubar.tsx && ! grep -q '\"mx-auto\"' src/components/jamlight-menubar.tsx && echo PASS",
        "grep -q 'w-full' src/components/jamlight-menubar.tsx && echo 'PASS: full-width'",
        "grep -q 'JamLightMenubar\\|Menubar' src/components/dashboard-app-shell.tsx || exit 1",
        "pnpm test || exit 1",
      ],
    });
    assert.deepEqual(
      validateShellContentWidthClaimProof(doc),
      [],
      "full-width intent must accept negative proofs",
    );
    assert.equal(
      validatePhaseDocForDev(doc).ok,
      true,
      validatePhaseDocForDev(doc).issues.join("; "),
    );
  });

  it("full-width intent: rejects checks with no full-width proof at all", () => {
    const doc = phaseDoc({
      scope: "Make the dashboard menubar full-width",
      successCriteria: "- Menubar spans the viewport",
      checks: [
        "grep -n 'viewSwitcher' src/components/shell/menubar.tsx || exit 1",
        "pnpm test || exit 1",
      ],
    });
    const issues = validateShellContentWidthClaimProof(doc);
    assert.ok(
      issues.some((i) => /full-width/i.test(i)),
      issues.join("; ") || "expected full-width guidance",
    );
    assert.equal(validatePhaseDocForDev(doc).ok, false);
  });

  it("content-aligned claim still rejects checks that only game the tokens", () => {
    // Negative greps mentioning --content-max must NOT satisfy a genuine
    // content-aligned claim — only a full-width intent unlocks them.
    const doc = phaseDoc({
      scope: "Centre the menubar over page content at --content-max",
      successCriteria: "- Inner bar matches content width",
      checks: [
        "! grep -q 'var(--content-max)' src/components/shell/menubar.tsx && echo PASS",
        "grep -n '<Menubar' playground/src/App.tsx || exit 1",
      ],
    });
    assert.ok(
      validateShellContentWidthClaimProof(doc).length > 0,
      "negative greps must not satisfy a content-aligned claim",
    );
  });

  it("accepts Next.js product shell mounts (JamPress) without playground", () => {
    const checks = `
grep -n '<ThemeToggle' src/components/layout/jampress-menubar.tsx || exit 1
grep -n '--content-max\\|maxWidth.*content-max' src/components/layout/jampress-menubar.tsx || exit 1
grep -n 'JampressMenubar' src/components/layout/marketing-shell.tsx || exit 1
grep -n 'JampressMenubar' src/components/layout/portal-shell.tsx || exit 1
pnpm build || exit 1
grep -q 'text-text-secondary\\|--text-secondary' src/app/globals.css node_modules/@jamroast/components/dist/styles/*.css 2>/dev/null || exit 1
`;
    assert.equal(
      automatedChecksProveThemeToggleMounted(checks),
      true,
      "theme mount",
    );
    assert.equal(
      automatedChecksProveContentAlignedMenubar(checks),
      true,
      "content-max + product shell",
    );
    assert.equal(
      automatedChecksProveThemeToggleStyleVisibility(checks),
      true,
    );
    const doc = phaseDoc({
      scope:
        "Landing content-max menubar; dashboard full-width shell; ThemeToggle on JampressMenubar",
      successCriteria:
        "- ThemeToggle visible on menubar; landing uses --content-max inner bar",
      checks: checks
        .trim()
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    });
    assert.deepEqual(validateThemeShellMountClaimProof(doc), []);
    assert.deepEqual(validateShellContentWidthClaimProof(doc), []);
    assert.equal(
      validatePhaseDocForDev(doc).ok,
      true,
      validatePhaseDocForDev(doc).issues.join("; "),
    );
  });
});

describe("claim-vs-proof claim surface + Next resolve", () => {
  it("ignores ThemeToggle only in Research notes under Scope", () => {
    const doc = `# Phase demo

## Scope
Apply landing layout.

### Research notes

ThemeToggle must mount in Menubar on the playground with content-max.

## File Changes
- src/components/layout/marketing-shell.tsx

## Success Criteria
- Landing layout matches mock

## Automated Checks

\`\`\`bash
pnpm test || exit 1
\`\`\`
`;
    assert.deepEqual(validateThemeShellMountClaimProof(doc), []);
    assert.deepEqual(validateShellContentWidthClaimProof(doc), []);
  });

  it("still claims ThemeToggle from Success Criteria", () => {
    const doc = phaseDoc({
      successCriteria:
        "- ThemeToggle is visible in Menubar on the playground page",
      checks: ["pnpm test || exit 1"],
    });
    assert.ok(validateThemeShellMountClaimProof(doc).length > 0);
  });

  it("accepts pnpm build / next build as finite resolve proofs", () => {
    assert.equal(
      automatedChecksHaveFiniteResolveProof("pnpm build || exit 1"),
      true,
    );
    assert.equal(
      automatedChecksHaveFiniteResolveProof("npx next build || exit 1"),
      true,
    );
    const doc = phaseDoc({
      successCriteria: "- CSS loads; no Can't resolve for package styles",
      checks: [
        "pnpm build || exit 1",
        "grep -q '@jamroast/components' package.json || exit 1",
      ],
    });
    assert.deepEqual(validateModuleResolveClaimProof(doc), []);
  });

  it("formatClaimProofChecksGuidance covers playground and product shells", () => {
    const text = formatClaimProofChecksGuidance({
      designShellOrTheme: true,
      shellNotes: [
        "Landing menubar: center an inner bar at max-width: var(--content-max)",
        "Dashboard menubar: full-viewport-width bar",
      ],
    });
    assert.match(text, /playground/i);
    assert.match(text, /JampressMenubar|product Next/i);
    assert.match(text, /pnpm build|next build/i);
    assert.match(text, /Dual chrome/i);
  });
});

describe("validateRuntimeClaimProofsAsync", () => {
  const exportOnlyDoc = phaseDoc({
    scope: "Mount ThemeToggle in the menubar shell",
    successCriteria: "- ThemeToggle is mounted in the menubar and visible",
    checks: ["grep -q 'export function ThemeToggle' src/theme-toggle.tsx || exit 1"],
  });

  it("drops a deterministic gap the judge rejects into warnings", async () => {
    const deterministic = validateRuntimeClaimProofs(exportOnlyDoc);
    assert.ok(deterministic.length > 0);
    const result = await validateRuntimeClaimProofsAsync(exportOnlyDoc, {
      judgeFn: async () => ({
        genuineGap: false,
        reason: "The grep plus playground render test already proves the mount.",
        existingProof: "grep -q 'export function ThemeToggle' src/theme-toggle.tsx",
      }),
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.warnings.length, deterministic.length);
    assert.match(result.warnings[0] ?? "", /rejected by LLM judge/);
    assert.match(result.warnings[0] ?? "", /render test/);
  });

  it("keeps a gap the judge confirms, appending the suggested check", async () => {
    const result = await validateRuntimeClaimProofsAsync(exportOnlyDoc, {
      judgeFn: async () => ({
        genuineGap: true,
        reason: "Export-only grep; no mount proof.",
        suggestedCheck: "grep -q '<ThemeToggle' src/shell/menubar.tsx || exit 1",
      }),
    });
    assert.equal(result.issues.length, validateRuntimeClaimProofs(exportOnlyDoc).length);
    assert.match(result.issues[0] ?? "", /Suggested check \(LLM judge\):/);
    assert.match(result.issues[0] ?? "", /<ThemeToggle/);
    assert.deepEqual(result.warnings, []);
  });

  it("fails closed when the judge throws", async () => {
    const deterministic = validateRuntimeClaimProofs(exportOnlyDoc);
    const result = await validateRuntimeClaimProofsAsync(exportOnlyDoc, {
      judgeFn: async () => {
        throw new Error("endpoint down");
      },
    });
    assert.deepEqual(result.issues, deterministic);
    assert.deepEqual(result.warnings, []);
  });

  it("passes through deterministic output when no judge is bound", async () => {
    const deterministic = validateRuntimeClaimProofs(exportOnlyDoc);
    const result = await validateRuntimeClaimProofsAsync(exportOnlyDoc);
    assert.deepEqual(result.issues, deterministic);
    assert.deepEqual(result.warnings, []);
  });

  it("skips the judge entirely when there are no deterministic issues", async () => {
    let judgeCalls = 0;
    const cleanDoc = phaseDoc({
      successCriteria: "- typecheck passes",
      checks: ["pnpm exec tsc --noEmit || exit 1"],
    });
    const result = await validateRuntimeClaimProofsAsync(cleanDoc, {
      judgeFn: async () => {
        judgeCalls += 1;
        return { genuineGap: true, reason: "n/a" };
      },
    });
    assert.equal(judgeCalls, 0);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.warnings, []);
  });

  it("labels issues with their claim kind for the judge", async () => {
    const claims: string[] = [];
    await validateRuntimeClaimProofsAsync(exportOnlyDoc, {
      judgeFn: async (input) => {
        claims.push(input.claim);
        return { genuineGap: true, reason: "real" };
      },
    });
    assert.ok(claims.length > 0);
    assert.ok(
      claims.every((c) =>
        ["theme-shell-mount", "theme-shell-visibility", "shell-content-width", "module-resolve", "runtime-claim"].includes(c),
      ),
    );
    assert.ok(claims.includes("theme-shell-mount"));
  });
});
