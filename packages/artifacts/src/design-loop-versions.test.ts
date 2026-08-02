import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  acceptDesignLoop,
  createDesignLoopMeta,
  readDesignLoopMeta,
  readDesignLoopMockHtml,
  writeDesignLoopAcceptance,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";
import {
  allocateNextDesignLoopVersion,
  assertActiveDesignLoopBase,
  buildDesignLoopVersionTree,
  invalidateDesignLoopVersion,
  listDesignLoopVersions,
  resolveDesignLoopTip,
} from "./design-loop-versions.js";

describe("design-loop-versions", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function setupLoop() {
    const root = mkdtempSync(join(tmpdir(), "slop-ver-"));
    roots.push(root);
    const meta = createDesignLoopMeta({ projectId: "p1", brief: "theme" });
    writeDesignLoopMeta(root, meta);
    return { root, meta };
  }

  it("backfills parentVersion for legacy META without parent/status", () => {
    const { root, meta } = setupLoop();
    const dir = join(root, ".slopcontrol", "design-loops", meta.id, "v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mock.html"), "<html>v2</html>\n");
    writeFileSync(
      join(dir, "META.json"),
      `${JSON.stringify({
        version: 2,
        usedScaffold: false,
        updatedAt: new Date().toISOString(),
      })}\n`,
    );
    const list = listDesignLoopVersions(root, meta.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.parentVersion, 1);
    assert.equal(list[0]!.status, "active");
    assert.equal(list[0]!.backfilled, true);
  });

  it("discard tip rewinds currentVersion; files remain; tree keeps children", () => {
    const { root, meta } = setupLoop();
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: "<html>v1</html>",
      parentVersion: null,
    });
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 2,
      html: "<html>v2</html>",
      parentVersion: 1,
    });
    writeDesignLoopMeta(root, {
      ...meta,
      currentVersion: 2,
      updatedAt: new Date().toISOString(),
    });

    const result = invalidateDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 2,
      reason: "bad layout",
    });
    assert.equal(result.tip, 1);
    assert.equal(result.loop.currentVersion, 1);
    assert.equal(result.version.status, "invalid");
    assert.match(result.version.invalidReason ?? "", /bad layout/);

    const built = buildDesignLoopVersionTree(root, meta.id);
    assert.equal(built.tip, 1);
    const v1 = built.tree.find((n) => n.version === 1);
    assert.ok(v1?.children.includes(2));
    assert.equal(allocateNextDesignLoopVersion(root, meta.id), 3);
    assert.ok(readDesignLoopMockHtml(root, meta.id, 2)?.includes("v2"));
  });

  it("cannot discard accepted version; cannot use invalid as base", () => {
    const { root, meta } = setupLoop();
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: "<html>v1</html>",
      parentVersion: null,
    });
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 2,
      html: "<html>v2</html>",
      parentVersion: 1,
    });
    writeDesignLoopMeta(root, {
      ...meta,
      currentVersion: 2,
      updatedAt: new Date().toISOString(),
    });
    writeDesignLoopAcceptance(root, meta.id, {
      version: 1,
      features: [
        { id: "logo", label: "Logo", accepted: true },
        { id: "palette", label: "Palette", accepted: false },
      ],
      acceptedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    writeDesignLoopMeta(root, {
      ...readDesignLoopMeta(root, meta.id)!,
      acceptedVersion: 1,
      status: "accepted",
      currentVersion: 2,
      updatedAt: new Date().toISOString(),
    });

    assert.throws(
      () =>
        invalidateDesignLoopVersion({
          projectRoot: root,
          loopId: meta.id,
          version: 1,
        }),
      /accepted/i,
    );

    invalidateDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 2,
    });
    assert.throws(
      () =>
        assertActiveDesignLoopBase({
          projectRoot: root,
          loopId: meta.id,
          version: 2,
        }),
      /invalid/i,
    );
    assert.doesNotThrow(() =>
      assertActiveDesignLoopBase({
        projectRoot: root,
        loopId: meta.id,
        version: 1,
      }),
    );
  });

  it("continue lineage: after discard tip, next allocate parents to tip", () => {
    const { root, meta } = setupLoop();
    for (const [v, parent] of [
      [1, null],
      [2, 1],
      [3, 2],
    ] as const) {
      writeDesignLoopVersion({
        projectRoot: root,
        loopId: meta.id,
        version: v,
        html: `<html>v${v}</html>`,
        parentVersion: parent,
      });
    }
    writeDesignLoopMeta(root, {
      ...meta,
      currentVersion: 3,
      updatedAt: new Date().toISOString(),
    });
    invalidateDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 3,
    });
    assert.equal(resolveDesignLoopTip(root, meta.id), 2);
    const next = allocateNextDesignLoopVersion(root, meta.id);
    assert.equal(next, 4);
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: next,
      html: "<html>v4 from v2</html>",
      parentVersion: 2,
    });
    writeDesignLoopMeta(root, {
      ...readDesignLoopMeta(root, meta.id)!,
      currentVersion: next,
      updatedAt: new Date().toISOString(),
    });
    const tree = buildDesignLoopVersionTree(root, meta.id);
    const v2 = tree.tree.find((n) => n.version === 2);
    assert.ok(v2?.children.includes(3));
    assert.ok(v2?.children.includes(4));
    assert.equal(tree.tip, 4);
  });

  it("cannot accept invalid version", () => {
    const { root, meta } = setupLoop();
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: "<html>v1</html>",
      parentVersion: null,
    });
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 2,
      html: "<html>v2 bad</html>",
      parentVersion: 1,
    });
    writeDesignLoopMeta(root, {
      ...meta,
      currentVersion: 2,
      status: "open",
      updatedAt: new Date().toISOString(),
    });
    invalidateDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 2,
    });
    assert.throws(
      () =>
        acceptDesignLoop(root, meta.id, 2, {
          acceptedFeatureIds: ["logo"],
        }),
      /invalid/i,
    );
  });
});
