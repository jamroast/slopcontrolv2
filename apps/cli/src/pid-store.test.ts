import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupByPgid,
  parseOwnedProcesses,
  selfPreserveIds,
} from "./pid-store.js";

const ROOT = "/Users/dev/Projects/slopconrolV2";

const PS_OUT = `  100     1   100 /bin/zsh
  200   100   200 node ${ROOT}/apps/cli/dist/index.js down
  6552  1008  6552 node /usr/local/bin/pnpm --filter @slopcontrol/server run dev
  7604  7598  6552 node --import file://${ROOT}/node_modules/.pnpm/tsx/dist/loader.mjs src/index.ts
 73637  6552  6552 ${ROOT}/packages/coding-tools/node_modules/.bin/opencode serve --port=4106
 95743     1 95743 node /usr/local/bin/pnpm --filter @slopcontrol/server dev
 96499 95743 95743 node ${ROOT}/apps/server/node_modules/.bin/tsx watch src/index.ts
 12345     1 12345 node /Users/dev/other-project/server.js
`;

describe("parseOwnedProcesses", () => {
  it("keeps only rows whose command mentions the repo rootDir", () => {
    const rows = parseOwnedProcesses(PS_OUT, ROOT, new Set([200, 100]));
    // pnpm/sh wrappers lack the rootDir in their command line — they are
    // killed via process-group membership of matching children instead.
    const pids = rows.map((r) => r.pid).sort((a, b) => a - b);
    assert.deepEqual(pids, [7604, 73637, 96499]);
  });

  it("excludes self pid and own process group", () => {
    const rows = parseOwnedProcesses(PS_OUT, ROOT, new Set([200, 6552]));
    assert.ok(!rows.some((r) => r.pid === 6552 || r.pgid === 6552));
  });

  it("never matches foreign projects with different roots", () => {
    const rows = parseOwnedProcesses(PS_OUT, ROOT, new Set());
    assert.ok(!rows.some((r) => r.pid === 12345));
  });
});

describe("selfPreserveIds", () => {
  it("walks the ppid chain to protect ancestors", () => {
    // pid 200 (the CLI) has ppid 100 (zsh) — both must be preserved.
    const ids = selfPreserveIds(PS_OUT, 200);
    assert.ok(ids.has(200));
    assert.ok(ids.has(100));
  });

  it("does not preserve unrelated trees", () => {
    const ids = selfPreserveIds(PS_OUT, 200);
    assert.ok(!ids.has(6552));
    assert.ok(!ids.has(95743));
  });

  it("protects descendants (own esbuild/tsx children) as well as ancestors", () => {
    const withChild =
      PS_OUT +
      `  300   200   8278 ${ROOT}/node_modules/.pnpm/@esbuild/bin/esbuild --service\n`;
    const ids = selfPreserveIds(withChild, 200);
    assert.ok(ids.has(300), "own child must be preserved");
    assert.ok(ids.has(8278), "child's process group must be preserved");
    const rows = parseOwnedProcesses(withChild, ROOT, ids);
    assert.ok(!rows.some((r) => r.pid === 300));
  });
});

describe("groupByPgid", () => {
  it("groups rows so whole trees (incl. unmatched pnpm wrappers) die together", () => {
    const rows = parseOwnedProcesses(PS_OUT, ROOT, new Set([200, 100]));
    const groups = groupByPgid(rows);
    assert.equal(groups.get(6552)?.length, 2);
    assert.equal(groups.get(95743)?.length, 1);
  });
});
