import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadSlopcontrolEnv, slopcontrolEnvCandidates } from "./load-env.js";

describe("loadSlopcontrolEnv", () => {
  it("includes ~/.slopcontrol/.env in candidates", () => {
    const paths = slopcontrolEnvCandidates("/tmp/proj");
    assert.ok(paths.some((p) => p.endsWith(".slopcontrol/.env")));
    assert.ok(paths.some((p) => p.endsWith("/tmp/proj/.env") || p.includes("proj")));
  });

  it("loads keys into env without overriding existing", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-cli-env-"));
    try {
      const homeSlop = join(dir, ".slopcontrol");
      mkdirSync(homeSlop, { recursive: true });
      writeFileSync(
        join(homeSlop, ".env"),
        "OLLAMA_API_KEY=from-home\nEXA_API_KEY=exa-home\n",
        "utf-8",
      );
      writeFileSync(join(dir, ".env"), "OLLAMA_API_KEY=from-root\n", "utf-8");

      const prevHome = process.env.HOME;
      process.env.HOME = dir;
      try {
        const env: NodeJS.ProcessEnv = {
          PATH: "/usr/bin",
          OLLAMA_API_KEY: "from-shell",
        };
        const { loaded } = loadSlopcontrolEnv({ rootDir: dir, env });
        assert.ok(loaded.length >= 1);
        // shell wins
        assert.equal(env.OLLAMA_API_KEY, "from-shell");
        // missing key filled from file (rootDir/.env loaded before home;
        // EXA only in home file)
        assert.equal(env.EXA_API_KEY, "exa-home");
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
