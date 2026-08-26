import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  clipBlueprintForPrompt,
  extractChangeIntent,
  probeProjectForDecisions,
  reconcileBlueprintDecisions,
  reconcileProjectBlueprint,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "fixtures", "ui-gate-project");

describe("ui-gate fixture + grounded reconcile", () => {
  it("probes fixture as composer mount", () => {
    const probes = probeProjectForDecisions(fixtureRoot);
    assert.equal(probes.mount, "composer");
    assert.equal(probes.hasComposerFormTestId, true);
    assert.ok(probes.evidence.some((e) => /composer-form/.test(e)));
  });

  it("ignores test-tree FormBubble actionable noise", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-probe-noise-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(
        join(dir, "src", "composer.tsx"),
        `export const x = <div data-testid="composer-form"><FormBubble actionable /></div>;\n`,
      );
      writeFileSync(
        join(dir, "tests", "bubble.test.ts"),
        `expect(src).toContain('<FormBubble actionable={true}');\n`,
      );
      const probes = probeProjectForDecisions(dir);
      assert.equal(probes.mount, "composer");
      assert.equal(probes.hasActionableBubbleForm, false);
      assert.ok(!probes.evidence.some((e) => e.startsWith("tests/")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconcile with probes verifies composer and strikes in-bubble", () => {
    const bp = readFileSync(
      join(fixtureRoot, ".slopcontrol", "BLUEPRINT.md"),
      "utf-8",
    );
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer.",
    );
    const probes = probeProjectForDecisions(fixtureRoot);
    const { blueprint, report } = reconcileBlueprintDecisions(
      bp,
      intent,
      probes,
    );
    assert.match(blueprint, /Live decisions — verified/i);
    assert.match(blueprint, /BD-COMPOSER-FORM-MODE/);
    assert.match(blueprint, /~~\*\*BD-IN-BUBBLE-FORMS\*\*~~/);
    assert.match(blueprint, /BD-MCP1/);
    assert.ok(report.some((r) => /verified|probe/i.test(r)));
    const clip = clipBlueprintForPrompt(blueprint, 2000);
    assert.match(clip, /verified/i);
    assert.doesNotMatch(clip, /BD-IN-BUBBLE-FORMS(?!.*superseded)/);
  });

  it("reconcileProjectBlueprint dryRun does not write", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-uigates-"));
    try {
      mkdirSync(join(dir, ".slopcontrol"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, ".slopcontrol", "BLUEPRINT.md"),
        `# Blueprint\n\n## Decisions\n\n- **BD-COMPOSER-FORM-MODE:** composer.\n- **BD-IN-BUBBLE-FORMS:** bubble.\n### BD-HEADING-1: heading style\n`,
      );
      writeFileSync(
        join(dir, "src", "app.tsx"),
        `export const x = <div data-testid="composer-form" />;\n`,
      );
      const before = readFileSync(
        join(dir, ".slopcontrol", "BLUEPRINT.md"),
        "utf-8",
      );
      const r = reconcileProjectBlueprint(dir, undefined, { dryRun: true });
      assert.equal(r.dryRun, true);
      assert.equal(
        readFileSync(join(dir, ".slopcontrol", "BLUEPRINT.md"), "utf-8"),
        before,
      );
      assert.ok(
        r.report.some((line) => /probe|verified|dedupe|mount/i.test(line)),
      );
      assert.match(r.liveDecisions, /BD-COMPOSER-FORM-MODE|BD-HEADING-1/);
      assert.ok(
        /verified|claimed/i.test(r.report.join("\n")) ||
          r.liveDecisions.length > 0,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
