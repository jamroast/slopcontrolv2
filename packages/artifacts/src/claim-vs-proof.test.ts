import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  automatedChecksHaveFiniteResolveProof,
  successCriteriaClaimsModuleResolve,
  validateModuleResolveClaimProof,
  validatePhaseDocForDev,
  validateRuntimeClaimProofs,
  validateRuntimeClaimProofsAsync,
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
});

describe("validateRuntimeClaimProofsAsync", () => {
  const resolveDoc = phaseDoc({
    successCriteria: "- no `Can't resolve` for package styles",
    checks: ["grep -q '@jamroast/components' package.json || exit 1"],
  });

  it("drops a deterministic gap the judge rejects into warnings", async () => {
    const deterministic = validateRuntimeClaimProofs(resolveDoc);
    assert.ok(deterministic.length > 0);
    const result = await validateRuntimeClaimProofsAsync(resolveDoc, {
      judgeFn: async () => ({
        genuineGap: false,
        reason: "The grep plus build already proves resolution.",
        existingProof: "pnpm build",
      }),
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.warnings.length, deterministic.length);
    assert.match(result.warnings[0] ?? "", /rejected by LLM judge/);
    assert.match(result.warnings[0] ?? "", /build/);
  });

  it("keeps a gap the judge confirms, appending the suggested check", async () => {
    const result = await validateRuntimeClaimProofsAsync(resolveDoc, {
      judgeFn: async () => ({
        genuineGap: true,
        reason: "Grep-only; no build proof.",
        suggestedCheck: "pnpm build || exit 1",
      }),
    });
    assert.equal(
      result.issues.length,
      validateRuntimeClaimProofs(resolveDoc).length,
    );
    assert.match(result.issues[0] ?? "", /Suggested check \(LLM judge\):/);
    assert.match(result.issues[0] ?? "", /pnpm build/);
    assert.deepEqual(result.warnings, []);
  });

  it("fails closed when the judge throws", async () => {
    const deterministic = validateRuntimeClaimProofs(resolveDoc);
    const result = await validateRuntimeClaimProofsAsync(resolveDoc, {
      judgeFn: async () => {
        throw new Error("endpoint down");
      },
    });
    assert.deepEqual(result.issues, deterministic);
    assert.deepEqual(result.warnings, []);
  });

  it("passes through deterministic output when no judge is bound", async () => {
    const deterministic = validateRuntimeClaimProofs(resolveDoc);
    const result = await validateRuntimeClaimProofsAsync(resolveDoc);
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
    await validateRuntimeClaimProofsAsync(resolveDoc, {
      judgeFn: async (input) => {
        claims.push(input.claim);
        return { genuineGap: true, reason: "real" };
      },
    });
    assert.ok(claims.length > 0);
    assert.ok(
      claims.every((c) => ["module-resolve", "runtime-claim"].includes(c)),
    );
    assert.ok(claims.includes("module-resolve"));
  });
});

describe("duplicate infra bring-up draft gate", () => {
  it("validatePhaseDocForDev rejects docker compose up when project has compose file", () => {
    const root = mkdtempSync(join(tmpdir(), "phasedoc-compose-"));
    try {
      writeFileSync(join(root, "docker-compose.yml"), "services: { postgres: {} }");
      const doc = phaseDoc({
        successCriteria: "- [x] runtime probe passes",
        checks: [
          "docker compose up -d postgres && trap 'docker compose down' EXIT; pg_isready -h localhost -p 5430 || exit 1",
        ],
      });
      const gate = validatePhaseDocForDev(doc, { projectRoot: root });
      assert.equal(gate.ok, false);
      assert.ok(
        gate.issues.some((i) => /test-services|restarts infra|tears down infra/i.test(i)),
        gate.issues.join("; "),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validatePhaseDocForDev allows db checks without bring-up in compose projects", () => {
    const root = mkdtempSync(join(tmpdir(), "phasedoc-compose-"));
    try {
      writeFileSync(join(root, "docker-compose.yml"), "services: { postgres: {} }");
      const doc = phaseDoc({
        successCriteria: "- [x] integration suite passes",
        checks: [
          "pnpm db:migrate && pnpm seed && npx vitest run tests/integration/oidc.test.ts",
        ],
      });
      const gate = validatePhaseDocForDev(doc, { projectRoot: root });
      assert.ok(
        !gate.issues.some((i) => /restarts infra|tears down infra/i.test(i)),
        gate.issues.join("; "),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validatePhaseDocForDev ignores docker compose up when no compose file", () => {
    const root = mkdtempSync(join(tmpdir(), "phasedoc-nocompose-"));
    try {
      const doc = phaseDoc({
        successCriteria: "- [x] probe",
        checks: ["docker compose up -d app; sleep 5; curl -sf localhost:3001 || exit 1"],
      });
      const gate = validatePhaseDocForDev(doc, { projectRoot: root });
      assert.ok(
        !gate.issues.some((i) => /restarts infra|tears down infra/i.test(i)),
        "no compose file → duplicate-infra guard not applicable",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
