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
  briefWantsSiblingInvestigation,
  buildSiblingInvestigationPack,
} from "./sibling-code-refs.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-sib-${name}-`));
}

describe("sibling-code-refs", () => {
  it("briefWantsSiblingInvestigation detects investigate language only", () => {
    assert.equal(
      briefWantsSiblingInvestigation("investigate JamPress chat"),
      true,
    );
    assert.equal(briefWantsSiblingInvestigation("add a button"), false);
    assert.equal(
      briefWantsSiblingInvestigation("just mention jamroast somehow"),
      false,
    );
  });

  it("buildSiblingInvestigationPack includes absolute paths and excerpts", () => {
    const parent = tmp("parent");
    const target = join(parent, "jamroast-components");
    const jampress = join(parent, "basic-web-agent");
    try {
      mkdirSync(join(target, "src"), { recursive: true });
      mkdirSync(join(jampress, "src", "chat"), { recursive: true });
      writeFileSync(
        join(jampress, "src", "chat", "composer.ts"),
        "export function ChatComposer() { return null; }\n",
      );
      writeFileSync(
        join(jampress, "src", "chat", "tools.ts"),
        "export const chatTools = [];\n",
      );

      const pack = buildSiblingInvestigationPack({
        targetRoot: target,
        brief:
          "Please investigate JamPress and learn from its chat gathering for a first component",
        listProjects: () => [
          { id: "1", name: "jampress", rootPath: jampress },
        ],
      });
      assert.match(pack, /SIBLING INVESTIGATION/);
      assert.match(pack, /basic-web-agent|jampress/i);
      assert.ok(pack.includes(jampress));
      assert.match(pack, /composer\.ts/);
      assert.match(pack, /ChatComposer/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
