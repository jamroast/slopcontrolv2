import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProjectConfigSchema } from "@slopcontrol/types";
import {
  resolveProjectEnv,
  writeResolvedEnvToWorktree,
  WORKTREE_RESOLVED_ENV_FILE,
} from "./project-env.js";

describe("resolveProjectEnv", () => {
  it("merges files and lets process.env win for file keys", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-proj-env-"));
    try {
      writeFileSync(join(root, ".env"), "DATABASE_URL=from-env\nFOO=1\n");
      writeFileSync(join(root, ".env.docker"), "DATABASE_URL=from-docker\nBAR=2\n");
      const config = ProjectConfigSchema.parse({});
      const resolved = resolveProjectEnv({
        projectRoot: root,
        config,
        processEnv: { DATABASE_URL: "from-process", PATH: "/usr/bin" },
      });
      assert.equal(resolved.env.DATABASE_URL, "from-process");
      assert.equal(resolved.env.FOO, "1");
      assert.equal(resolved.env.BAR, "2");
      assert.equal(resolved.env.PATH, undefined);
      assert.ok(resolved.fromProcess.includes("DATABASE_URL"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passthrough prefixes pull CI-only keys", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-proj-prefix-"));
    try {
      writeFileSync(join(root, ".env"), "APP=1\n");
      const resolved = resolveProjectEnv({
        projectRoot: root,
        config: ProjectConfigSchema.parse({
          envPassthroughPrefixes: ["CLERK_"],
        }),
        processEnv: {
          APP: "from-process",
          CLERK_SECRET_KEY: "sk_test",
          UNRELATED: "nope",
        },
      });
      assert.equal(resolved.env.APP, "from-process");
      assert.equal(resolved.env.CLERK_SECRET_KEY, "sk_test");
      assert.equal(resolved.env.UNRELATED, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies envMap and llmModelMap to values", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-proj-map-"));
    try {
      writeFileSync(
        join(root, ".env.test"),
        "AI_CHAT_MODEL=glm-5.2:cloud\nREDIS_URL=redis://prod\n",
      );
      const resolved = resolveProjectEnv({
        projectRoot: root,
        config: ProjectConfigSchema.parse({
          envMap: { "redis://prod": "redis://127.0.0.1:6379" },
          llmModelMap: { "glm-5.2:cloud": "llama3.2" },
        }),
        processEnv: {},
      });
      assert.equal(resolved.env.AI_CHAT_MODEL, "llama3.2");
      assert.equal(resolved.env.REDIS_URL, "redis://127.0.0.1:6379");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes .env.slopcontrol into worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-proj-write-"));
    try {
      const written = writeResolvedEnvToWorktree({
        worktreePath: root,
        env: { FOO: "bar", BAZ: "qux" },
      });
      assert.equal(written, WORKTREE_RESOLVED_ENV_FILE);
      assert.ok(existsSync(join(root, WORKTREE_RESOLVED_ENV_FILE)));
      assert.match(readFileSync(join(root, WORKTREE_RESOLVED_ENV_FILE), "utf-8"), /FOO=bar/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
