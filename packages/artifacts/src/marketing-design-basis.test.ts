import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readDesignLoopElements } from "./design-element.js";
import {
  createDesignLoopMeta,
  readDesignLoopMeta,
  writeDesignLoopMeta,
} from "./design-loop.js";
import { getDesignLoopSelections } from "./design-loop-selections.js";
import { designBriefFromPack } from "./marketing-loop.js";
import {
  collectMarketingDesignBasis,
  formatMarketingDesignBasisBlock,
  seedMarketingDesignLoop,
} from "./marketing-design-basis.js";

describe("marketing design basis", () => {
  it("collects the depended-on landing elements and the canonical logo", () => {
    const root = mkdtempSync(join(tmpdir(), "mkt-basis-"));
    const app = join(root, "app");
    const lib = join(root, "ui-kit");
    try {
      mkdirSync(app, { recursive: true });
      writeFileSync(
        join(app, "package.json"),
        JSON.stringify({ name: "app", dependencies: { "@acme/ui": "1.0.0" } }),
      );
      const prior = createDesignLoopMeta({ projectId: "app", brief: "prior" });
      writeDesignLoopMeta(app, {
        ...prior,
        status: "accepted",
        acceptedVersion: 1,
        currentVersion: 1,
      });
      const assets = join(app, ".slopcontrol", "design-loops", prior.id, "assets");
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(assets, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
      writeFileSync(join(assets, "icon-pack.png"), "not-a-logo");

      mkdirSync(join(lib, ".slopcontrol", "elements", "menubar", "v2"), { recursive: true });
      mkdirSync(join(lib, ".slopcontrol", "elements", "dashboard-shell", "v1"), {
        recursive: true,
      });
      const stamp = "2026-01-01T00:00:00.000Z";
      writeFileSync(
        join(lib, "package.json"),
        JSON.stringify({ name: "@acme/ui" }),
      );
      writeFileSync(
        join(lib, ".slopcontrol", "elements", "INDEX.json"),
        JSON.stringify({
          updatedAt: stamp,
          elements: [
            {
              id: "menubar",
              latestVersion: 2,
              kind: "control",
              label: "Top bar",
              status: "published",
              updatedAt: stamp,
            },
            {
              id: "dashboard-shell",
              latestVersion: 1,
              kind: "shell",
              label: "Shell",
              status: "published",
              updatedAt: stamp,
            },
          ],
        }),
      );
      writeFileSync(
        join(lib, ".slopcontrol", "elements", "menubar", "v2", "ELEMENT.json"),
        JSON.stringify({
          id: "menubar",
          kind: "control",
          label: "Top bar",
          version: 2,
          publishedAt: stamp,
          updatedAt: stamp,
        }),
      );
      writeFileSync(
        join(lib, ".slopcontrol", "elements", "menubar", "v2", "SPEC.md"),
        "Top bar\n",
      );
      writeFileSync(
        join(lib, ".slopcontrol", "elements", "menubar", "v2", "mock.html"),
        "<header class=\"menubar\">Mark</header>\n",
      );

      const listProjects = () => [
        { id: "lib", name: "ui-kit", rootPath: lib },
        { id: "app", name: "app", rootPath: app },
      ];
      const basis = collectMarketingDesignBasis({
        projectRoot: app,
        listProjects,
      });
      assert.deepEqual(
        basis.elements.map((el) => el.id),
        ["menubar"],
      );
      assert.equal(basis.elements[0]?.version, 2);
      assert.equal(basis.elements[0]?.packageName, "@acme/ui");
      assert.ok(basis.logos.some((logo) => logo.name === "logo.svg"));
      assert.equal(basis.logos.some((logo) => logo.name === "icon-pack.png"), false);
      const block = formatMarketingDesignBasisBlock(basis);
      assert.match(block, /menubar@2/);
      assert.match(block, /logo\.svg/);

      const loop = createDesignLoopMeta({ projectId: "app", brief: "landing" });
      writeDesignLoopMeta(app, loop);
      const seeded = seedMarketingDesignLoop({
        projectRoot: app,
        loopId: loop.id,
        projectId: "app",
        listProjects,
      });
      assert.deepEqual(seeded.importedElementIds, ["menubar"]);
      assert.ok(
        readDesignLoopElements(app, loop.id).some((el) => el.id === "menubar"),
      );
      const meta = readDesignLoopMeta(app, loop.id);
      assert.equal(meta?.composeFromLibrary, true);
      assert.equal(
        getDesignLoopSelections(meta).find((sel) => sel.slot === "logo")?.asset,
        "logo.svg",
      );
      const brief = designBriefFromPack(
        {
          version: 1,
          audience: "Builders",
          competitors: "https://example.com",
          positioning: "Outcome first",
          claims: [],
          landingNarrative: "Show the product.",
          risks: "",
          handoff: "",
          tracks: [],
        },
        [],
        block,
      );
      assert.match(brief, /menubar@2/);
      assert.match(brief, /Do not invent a new mark/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
