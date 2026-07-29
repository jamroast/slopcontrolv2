import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenCodeEnv } from "./ensure-opencode.js";

describe("buildOpenCodeEnv", () => {
  it("enables Exa when EXA_API_KEY is present", () => {
    const env = buildOpenCodeEnv({
      PATH: "/usr/bin",
      EXA_API_KEY: "exa-secret",
    });
    assert.equal(env.EXA_API_KEY, "exa-secret");
    assert.equal(env.OPENCODE_ENABLE_EXA, "1");
  });

  it("accepts SLOPCONTROL_EXA_API_KEY alias", () => {
    const env = buildOpenCodeEnv({
      PATH: "/usr/bin",
      SLOPCONTROL_EXA_API_KEY: "sc-exa",
    });
    assert.equal(env.EXA_API_KEY, "sc-exa");
    assert.equal(env.OPENCODE_ENABLE_EXA, "1");
  });

  it("does not force OPENCODE_ENABLE_EXA without a key", () => {
    const env = buildOpenCodeEnv({ PATH: "/usr/bin" });
    assert.equal(env.OPENCODE_ENABLE_EXA, undefined);
  });
});
