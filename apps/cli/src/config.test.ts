import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { findConfigPath, loadConfigFile } from "./config.js";
import {
  DEFAULT_SLOPCONTROL_YAML,
  SlopcontrolYamlSchema,
} from "./config-schema.js";

describe("slopcontrol.yaml schema", () => {
  it("parses defaults for empty object", () => {
    const cfg = SlopcontrolYamlSchema.parse({});
    assert.equal(cfg.version, 1);
    assert.equal(cfg.server.port, 3020);
    assert.equal(cfg.coding.engine, "pi");
    assert.match(cfg.server.health.http, /3020/);
  });

  it("parses DEFAULT_SLOPCONTROL_YAML", () => {
    const raw = parseYaml(DEFAULT_SLOPCONTROL_YAML);
    const cfg = SlopcontrolYamlSchema.parse(raw);
    assert.equal(cfg.coding.engine, "pi");
    assert.equal(cfg.web?.enabled, false);
    assert.equal(cfg.coding.opencode?.port, 4096);
  });

  it("findConfigPath walks up then would fall back to home", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-cli-cfg-"));
    try {
      const nested = join(root, "a", "b");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(root, "slopcontrol.yaml"),
        "version: 1\nserver:\n  health: { http: \"http://127.0.0.1:3020/health\" }\n  command: [\"echo\",\"ok\"]\n",
        "utf-8",
      );
      const found = findConfigPath(nested);
      assert.equal(found, join(root, "slopcontrol.yaml"));
      const loaded = loadConfigFile(found!);
      assert.equal(loaded.version, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
