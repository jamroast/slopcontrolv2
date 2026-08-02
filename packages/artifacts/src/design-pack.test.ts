import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  acceptDesignLoop,
  createDesignLoopMeta,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
  bindAcceptedDesignLoopToPhase,
} from "./design-loop.js";
import {
  compileDesignPackFromAccept,
  formatDesignPackPromptBlock,
  readDesignLoopPack,
  readPhaseDesignPack,
} from "./design-pack.js";

describe("design-pack", () => {
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

  it("compileDesignPackFromAccept extracts tokens logos shell content", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dpack-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "JamRoast agency theming",
    });
    writeDesignLoopMeta(root, meta);
    mkdirSync(join(root, ".slopcontrol", "design-loops", meta.id, "assets"), {
      recursive: true,
    });
    writeFileSync(
      join(
        root,
        ".slopcontrol",
        "design-loops",
        meta.id,
        "assets",
        "ember.png",
      ),
      "fake",
    );
    const html = `<!DOCTYPE html><html><head><style>
:root { --accent: #E8430A; --font-display: "Fraunces", serif; }
</style></head><body>
<div class="section-label"><b>1</b> Palette — warm</div>
<div class="section-label"><b>2</b> Logo — ember ring</div>
<h1>JamRoast agency for builders</h1>
<button class="theme-toggle">Dark / Light</button>
<span>Clerk sign-in</span>
</body></html>`;
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html,
      notes: "Agency angle not platform",
      request:
        "Make it an agency with Taste Room and Clerk on the dashboard; dark and light mode",
    });

    const pack = compileDesignPackFromAccept({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      acceptance: {
        version: 1,
        features: [
          { id: "palette", label: "Palette", accepted: true },
          { id: "logo", label: "Logo", accepted: true },
          { id: "applied_shell", label: "Shell", accepted: false },
        ],
      },
      meta,
    });

    assert.match(pack.tokens, /--accent/);
    assert.ok(pack.logos.some((l) => l.name === "ember.png"));
    assert.ok(pack.typography.length >= 1);
    assert.ok(pack.shell.some((s) => /dark|light|clerk|taste/i.test(s)));
    assert.ok(pack.contentPillars.length >= 1);
    assert.deepEqual(pack.inScope, ["palette", "logo"]);
    assert.ok(pack.mustNot.some((m) => /applied_shell|OUT OF SCOPE/i.test(m)));
    assert.match(formatDesignPackPromptBlock(pack), /Design pack/);
    assert.match(formatDesignPackPromptBlock(pack), /ember\.png/);
  });

  it("accept writes DESIGN_PACK.json; bind copies to phase", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dpack-bind-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "Theme pack test",
    });
    writeDesignLoopMeta(root, meta);
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: `<!DOCTYPE html><html><head><style>:root{--x:1}</style></head>
<body><div class="section-label"><b>1</b> Logo — mark</div></body></html>`,
      notes: "ok",
      request: "logo and palette",
    });

    acceptDesignLoop(root, meta.id, 1, {
      acceptedFeatureIds: ["palette", "logo"],
    });
    const packPath = join(
      root,
      ".slopcontrol",
      "design-loops",
      meta.id,
      "DESIGN_PACK.json",
    );
    assert.equal(existsSync(packPath), true);
    const pack = readDesignLoopPack(root, meta.id);
    assert.ok(pack);
    assert.equal(pack!.sourceMockVersion, 1);

    mkdirSync(join(root, ".slopcontrol", "phases", "01-look"), {
      recursive: true,
    });
    bindAcceptedDesignLoopToPhase({
      projectRoot: root,
      loopId: meta.id,
      phaseId: "01-look",
    });
    const phasePack = readPhaseDesignPack(root, "01-look");
    assert.ok(phasePack);
    assert.match(phasePack!.mockPath, /phases\/01-look\/design\/mock\.html/);
    assert.equal(
      existsSync(
        join(root, ".slopcontrol", "phases", "01-look", "design", "DESIGN_PACK.json"),
      ),
      true,
    );
    const raw = readFileSync(
      join(root, ".slopcontrol", "phases", "01-look", "design", "DESIGN_PACK.json"),
      "utf-8",
    );
    assert.match(raw, /contentPillars/);
  });
});
