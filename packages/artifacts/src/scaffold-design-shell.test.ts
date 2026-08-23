import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  scaffoldPhaseDoc,
  validatePhaseDocForDev,
} from "./index.js";

describe("scaffoldPhaseDoc design-bound shell", () => {
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

  it("emits shell claim-vs-proof checks when design acceptance is bound", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-scaffold-shell-"));
    roots.push(root);
    const phaseId = "63-dual-shell";
    const designDir = join(root, ".slopcontrol", "phases", phaseId, "design");
    mkdirSync(designDir, { recursive: true });
    writeFileSync(
      join(designDir, "ACCEPTANCE.json"),
      `${JSON.stringify(
        {
          version: 1,
          features: [
            { id: "theme_modes", label: "Theme", accepted: true },
            { id: "applied_shell", label: "Shell", accepted: true },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(designDir, "DESIGN_PACK.json"),
      `${JSON.stringify(
        {
          name: "test",
          version: 1,
          loopId: "loop",
          projectId: "p",
          sourceMockVersion: 1,
          tokens: "",
          logos: [],
          typography: [],
          shell: [
            "Landing menubar: center an inner bar at max-width: var(--content-max)",
            "Dashboard menubar: full-viewport-width bar",
          ],
          contentPillars: [],
          inScope: ["theme_modes", "applied_shell"],
          mustNot: [],
          mockPath: "design/mock.html",
        },
        null,
        2,
      )}\n`,
    );

    const doc = scaffoldPhaseDoc({
      phaseId,
      description:
        "Please revise the applied frames to match jamroast-components chrome",
      research:
        "ThemeToggle must mount in Menubar on the playground with content-max inner bar.",
      testCommand: "pnpm test",
      projectRoot: root,
    });

    assert.ok(!/### Research notes/i.test(doc), "must not paste research dumps");
    assert.match(doc, /ThemeToggle/);
    assert.match(doc, /content-max|JampressMenubar/);
    assert.match(doc, /pnpm build|next build|vite build/);

    const gate = validatePhaseDocForDev(doc, {
      projectRoot: root,
      phaseId,
    });
    assert.equal(gate.ok, true, gate.issues.join("; "));
    assert.equal(existsSync(join(designDir, "ACCEPTANCE.json")), true);
  });

  it("keeps brand scaffold when no design acceptance", () => {
    const doc = scaffoldPhaseDoc({
      phaseId: "09-brand",
      description: "Port sibling theming and cleaner logos for the app",
      research: "ThemeToggle research dump should appear for non-design scaffold",
      testCommand: "npm test",
      intent: {
        title: "Brand theming",
        goal: "Apply sibling brand palette and logos",
        changeKind: "other",
        description: "Port sibling theming and cleaner logos for the app",
      } as never,
    });
    assert.match(doc, /public\/brand/);
    assert.match(doc, /Research notes/);
    assert.equal(validatePhaseDocForDev(doc).ok, true);
  });

  it("generates checks from discovered shell paths for a generic (non-Jam) project", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-scaffold-generic-"));
    roots.push(root);
    const phaseId = "01-shell";
    const designDir = join(root, ".slopcontrol", "phases", phaseId, "design");
    mkdirSync(designDir, { recursive: true });
    writeFileSync(
      join(designDir, "ACCEPTANCE.json"),
      `${JSON.stringify({
        version: 1,
        features: [{ id: "theme_modes", label: "Theme modes", accepted: true }],
      }, null, 2)}\n`,
    );
    // Generic project layout — no Jam paths anywhere.
    mkdirSync(join(root, "src", "components", "chrome"), { recursive: true });
    writeFileSync(join(root, "src", "components", "chrome", "app-navbar.tsx"), "export {}\n");
    mkdirSync(join(root, "playground", "src"), { recursive: true });
    writeFileSync(join(root, "playground", "src", "App.tsx"), "export {}\n");
    writeFileSync(join(root, "src", "index.css"), ":root {}\n");

    const doc = scaffoldPhaseDoc({
      phaseId,
      description: "Dual-theme shell",
      testCommand: "npm test",
      projectRoot: root,
    });
    // Checks reference the discovered paths, not Jam file names.
    assert.match(doc, /app-navbar\.tsx/);
    assert.match(doc, /src\/index\.css/);
    assert.doesNotMatch(doc, /jampress-menubar/);
    assert.doesNotMatch(doc, /JampressMenubar/);
    assert.doesNotMatch(doc, /@jamroast/);
  });

  it("JamPress-shaped project discovers the same paths it used to hardcode", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-scaffold-jampress-"));
    roots.push(root);
    const phaseId = "01-shell";
    const designDir = join(root, ".slopcontrol", "phases", phaseId, "design");
    mkdirSync(designDir, { recursive: true });
    writeFileSync(
      join(designDir, "ACCEPTANCE.json"),
      `${JSON.stringify({
        version: 1,
        features: [{ id: "applied_shell", label: "Shell", accepted: true }],
      }, null, 2)}\n`,
    );
    // JamPress layout — discovery must surface these exact paths.
    mkdirSync(join(root, "src", "components", "layout"), { recursive: true });
    writeFileSync(
      join(root, "src", "components", "layout", "jampress-menubar.tsx"),
      "export {}\n",
    );
    mkdirSync(join(root, "playground", "src"), { recursive: true });
    writeFileSync(join(root, "playground", "src", "App.tsx"), "export {}\n");

    const doc = scaffoldPhaseDoc({
      phaseId,
      description: "Dual-theme shell",
      testCommand: "npm test",
      projectRoot: root,
    });
    assert.match(doc, /jampress-menubar\.tsx/);
    assert.match(doc, /playground\/src\/App\.tsx/);
  });
});
