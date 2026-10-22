import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectProjectConventions,
  extractWorkflowRunCommands,
  readProjectConventionsPromptBlock,
  renderProjectConventions,
  writeProjectConventions,
  projectConventionsPath,
} from "./project-conventions.js";

function withTempProject(
  files: Record<string, string>,
  fn: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "sc-conventions-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, ...rel.split("/").slice(0, -1)), {
        recursive: true,
      });
      writeFileSync(join(root, ...rel.split("/")), body);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("extractWorkflowRunCommands", () => {
  it("extracts inline and block-scalar run commands", () => {
    const body = `
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - run: cargo test --workspace
      - name: lint
        run: |
          cargo fmt --check
          cargo clippy -- -D warnings
      - run: >
          echo folded
          command
`;
    assert.deepEqual(extractWorkflowRunCommands(body), [
      "cargo test --workspace",
      "cargo fmt --check && cargo clippy -- -D warnings",
      "echo folded command",
    ]);
  });

  it("skips comments in block scalars and empty runs", () => {
    const body = `
      - run: |
          # setup
          make check
      - run:
`;
    assert.deepEqual(extractWorkflowRunCommands(body), ["make check"]);
  });
});

describe("collectProjectConventions", () => {
  it("returns null when the project declares nothing", () => {
    withTempProject({ "package.json": "{}" }, (root) => {
      assert.equal(collectProjectConventions(root), null);
    });
  });

  it("collects AGENTS.md excerpts and CI run commands", () => {
    withTempProject(
      {
        "AGENTS.md": "# Rules\n\nAlways run the full check suite before push.\n",
        ".github/workflows/ci.yml":
          "jobs:\n  t:\n    steps:\n      - run: make test\n",
      },
      (root) => {
        const c = collectProjectConventions(root);
        assert.ok(c);
        assert.deepEqual(c.sources.sort(), [
          ".github/workflows/ci.yml",
          "AGENTS.md",
        ]);
        assert.match(c.docExcerpts[0]!.excerpt, /full check suite/);
        assert.deepEqual(c.ciCheckCommands, ["make test"]);
      },
    );
  });

  it("renders verbatim quotes, never estate vocabulary of its own", () => {
    withTempProject(
      {
        "CONTRIBUTING.md": "Run the linters before review.\n",
      },
      (root) => {
        const c = collectProjectConventions(root)!;
        const md = renderProjectConventions(c);
        assert.match(md, /## CONTRIBUTING\.md \(verbatim\)/);
        assert.match(md, /Run the linters before review\./);
      },
    );
  });
});

describe("writeProjectConventions / prompt block", () => {
  it("writes the artifact and the prompt block cites it generically", () => {
    withTempProject(
      {
        "AGENTS.md": "Verify with the project's own harness.\n",
      },
      (root) => {
        const path = writeProjectConventions(root);
        assert.equal(path, projectConventionsPath(root));
        const block = readProjectConventionsPromptBlock(root);
        assert.match(block, /declared conventions/);
        assert.match(block, /project's own harness/);
      },
    );
  });

  it("removes a stale artifact when conventions vanish", () => {
    withTempProject({ "AGENTS.md": "x" }, (root) => {
      assert.ok(writeProjectConventions(root));
      rmSync(join(root, "AGENTS.md"));
      assert.equal(writeProjectConventions(root), null);
      assert.equal(existsSync(projectConventionsPath(root)), false);
      assert.equal(readProjectConventionsPromptBlock(root), "");
    });
  });
});
