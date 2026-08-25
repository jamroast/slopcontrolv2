import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostVerifyEnvResultSchema } from "./host-verify-env-llm.js";

describe("HostVerifyEnvResultSchema", () => {
  it("accepts a rewrite list", () => {
    const parsed = HostVerifyEnvResultSchema.parse({
      rewrites: [
        {
          key: "DATABASE_URL",
          original: "postgresql://u:p@app-db:5432/db",
          rewritten: "postgresql://u:p@localhost:5430/db",
          reason: "compose-internal service",
        },
      ],
    });
    assert.equal(parsed.rewrites.length, 1);
    assert.equal(parsed.rewrites[0]!.key, "DATABASE_URL");
  });

  it("accepts an empty rewrite list", () => {
    const parsed = HostVerifyEnvResultSchema.parse({ rewrites: [] });
    assert.equal(parsed.rewrites.length, 0);
  });

  it("rejects malformed payloads", () => {
    assert.throws(() => HostVerifyEnvResultSchema.parse({}));
    assert.throws(() =>
      HostVerifyEnvResultSchema.parse({ rewrites: [{ key: "x" }] }),
    );
  });
});
