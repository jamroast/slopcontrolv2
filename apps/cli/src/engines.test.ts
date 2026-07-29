import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOpenCodeCommand,
  buildOpenCodeHealthUrl,
  resolveCodingEngine,
} from "./engines.js";
import { SlopcontrolYamlSchema } from "./config-schema.js";

describe("coding engine starters", () => {
  it("builds default opencode serve argv", () => {
    const cmd = buildOpenCodeCommand({
      port: 4096,
      hostname: "127.0.0.1",
    });
    assert.deepEqual(cmd, [
      "opencode",
      "serve",
      "--port",
      "4096",
      "--hostname",
      "127.0.0.1",
    ]);
  });

  it("honors command override", () => {
    const cmd = buildOpenCodeCommand({
      port: 1,
      hostname: "x",
      commandOverride: ["opencode", "serve", "--port", "9999"],
    });
    assert.deepEqual(cmd, ["opencode", "serve", "--port", "9999"]);
  });

  it("builds health URL", () => {
    assert.equal(
      buildOpenCodeHealthUrl("127.0.0.1", 4096),
      "http://127.0.0.1:4096/global/health",
    );
  });

  it("resolveCodingEngine returns opencode plan", () => {
    const config = SlopcontrolYamlSchema.parse({
      coding: {
        engine: "opencode",
        opencode: { port: 4100, hostname: "127.0.0.1", enableExa: true },
      },
    });
    const plan = resolveCodingEngine(config, {
      PATH: "/usr/bin",
      EXA_API_KEY: "exa",
    });
    assert.equal(plan.engineId, "opencode");
    assert.equal(plan.serviceId, "coding");
    assert.equal(plan.healthMode, "opencode");
    assert.match(plan.healthUrl, /4100/);
    assert.equal(plan.command[0], "opencode");
    assert.equal(plan.env.OPENCODE_ENABLE_EXA, "1");
  });

  it("rejects unknown coding engine", () => {
    const config = SlopcontrolYamlSchema.parse({
      coding: { engine: "not-a-real-engine" },
    });
    assert.throws(
      () => resolveCodingEngine(config),
      /Unknown coding engine/,
    );
  });
});
