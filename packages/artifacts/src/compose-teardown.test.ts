import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyHostVerifyEnvOverlay,
  dockerRowIsWorktreeOwned,
  freeHostPortsScopedToWorktrees,
  listComposeServiceNames,
  parseDockerPsRow,
  rewriteComposeServiceUrlForHostVerify,
  snapshotCanonicalRuntimeEnv,
  tearDownComposeInDir,
} from "./compose-teardown.js";

describe("tearDownComposeInDir", () => {
  it("skips when no compose file is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-compose-"));
    try {
      const r = tearDownComposeInDir(dir);
      assert.equal(r.attempted, false);
      assert.equal(r.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attempts docker compose down when compose.yml exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-compose-"));
    try {
      writeFileSync(
        join(dir, "docker-compose.yml"),
        "services:\n  noop:\n    image: alpine:3.19\n    command: ['true']\n",
      );
      const r = tearDownComposeInDir(dir);
      assert.equal(r.attempted, true);
      // May fail if docker unavailable in CI — still must have attempted.
      assert.ok(typeof r.output === "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshotCanonicalRuntimeEnv", () => {
  it("captures registry keys from product .env files", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-canon-env-"));
    try {
      writeFileSync(
        join(dir, ".env"),
        [
          "DB_PORT=5544",
          "SLOPCONTROL_NPM_REGISTRY_URL=http://127.0.0.1:4873/",
          "SLOPCONTROL_NPM_REGISTRY_DOCKER_URL=http://host.docker.internal:4873/",
          "SLOPCONTROL_NPM_REGISTRY_TOKEN=tok-abc123",
          "UNRELATED_KEY=nope",
          "",
        ].join("\n"),
        "utf-8",
      );
      const snap = snapshotCanonicalRuntimeEnv(dir);
      const env = snap.files[".env"];
      assert.ok(env);
      assert.equal(
        env.SLOPCONTROL_NPM_REGISTRY_URL,
        "http://127.0.0.1:4873/",
      );
      assert.equal(
        env.SLOPCONTROL_NPM_REGISTRY_DOCKER_URL,
        "http://host.docker.internal:4873/",
      );
      assert.equal(env.SLOPCONTROL_NPM_REGISTRY_TOKEN, "tok-abc123");
      assert.equal(env.UNRELATED_KEY, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("freeHostPortsScopedToWorktrees", () => {
    it("returns not-attempted for an empty port list", () => {
      const r = freeHostPortsScopedToWorktrees({
        ports: [],
        worktreesRoot: "/tmp/nope",
      });
      assert.equal(r.attempted, false);
      assert.equal(r.ok, true);
    });

    it("never touches non-worktree containers (operator stack safe)", () => {
      // No worktree dir on disk → no worktree-owned container can match,
      // even if something publishes a canonical port.
      const r = freeHostPortsScopedToWorktrees({
        ports: [5432],
        worktreesRoot: "/tmp/slop-no-such-worktrees",
      });
      assert.equal(r.ok, true);
      assert.ok(
        !r.output.includes("Stopped") ||
          r.output.includes("No worktree-owned"),
        `unexpected stop: ${r.output}`,
      );
    });

    it("ownership: worktree paths and slopwt- projects only", () => {
      const wt = "/home/x/.slopcontrol/worktrees/proj-1";
      // Worktree working_dir → owned
      assert.equal(
        dockerRowIsWorktreeOwned({ workingDir: `${wt}/01-phase` }, wt),
        true,
      );
      // slopwt- compose project → owned even without working_dir
      assert.equal(
        dockerRowIsWorktreeOwned({ composeProject: "slopwt-01-phase" }, wt),
        true,
      );
      // Operator stack at project root → not owned
      assert.equal(
        dockerRowIsWorktreeOwned({ workingDir: "/home/x/Projects/app" }, wt),
        false,
      );
      // Operator compose project name → not owned
      assert.equal(
        dockerRowIsWorktreeOwned({ composeProject: "jamauth" }, wt),
        false,
      );
      // No labels at all → not owned (never stop unlabeled containers on canonical ports)
      assert.equal(dockerRowIsWorktreeOwned({}, wt), false);
    });

    it("parseDockerPsRow reads the label columns", () => {
      const row = parseDockerPsRow(
        'abc123\t0.0.0.0:5430->5432/tcp\tjamauth-postgres\t/Users/x/Projects/jamauth\tjamauth',
      );
      assert.equal(row?.id, "abc123");
      assert.equal(row?.portsCol, "0.0.0.0:5430->5432/tcp");
      assert.equal(row?.name, "jamauth-postgres");
      assert.equal(row?.workingDir, "/Users/x/Projects/jamauth");
      assert.equal(row?.composeProject, "jamauth");
      assert.equal(parseDockerPsRow(""), null);
      assert.equal(parseDockerPsRow("  "), null);
    });
  });

  describe("host verify env overlay", () => {
    it("listComposeServiceNames reads top-level service keys", () => {
      const root = mkdtempSync(join(tmpdir(), "slop-compose-svc-"));
      try {
        writeFileSync(
          join(root, "docker-compose.yml"),
          "services:\n  app-db:\n    image: postgres:16\n  web:\n    build: .\n",
        );
        assert.deepEqual(listComposeServiceNames(root).sort(), ["app-db", "web"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("rewrites compose service hostnames to localhost for host verify", () => {
      const services = new Set(["app-db"]);
      const url = "postgresql://u:p@app-db:5432/mydb";
      const out = rewriteComposeServiceUrlForHostVerify(url, {
        hostPort: 5430,
        composeServiceNames: services,
      });
      assert.match(out, /localhost:5430/);
      assert.doesNotMatch(out, /app-db/);
    });

    it("applyHostVerifyEnvOverlay is generic (compose-derived, not product-specific)", () => {
      const root = mkdtempSync(join(tmpdir(), "slop-compose-overlay-"));
      try {
        writeFileSync(
          join(root, "docker-compose.yml"),
          'services:\n  svc-postgres:\n    ports:\n      - "5430:5432"\n',
        );
        writeFileSync(join(root, ".env"), "DB_PORT=5430\n");
        const { env, notes } = applyHostVerifyEnvOverlay(root, {
          DATABASE_URL: "postgresql://u:p@svc-postgres:5432/db",
        });
        assert.match(env.DATABASE_URL ?? "", /localhost:5430/);
        assert.ok(notes.some((n) => n.includes("host-verify")));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
