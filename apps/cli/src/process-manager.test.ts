import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { ensureService } from "./process-manager.js";

describe("ensureService external adoption", () => {
  it(
    "records the real pid of an already-healthy external service so `down` can stop it",
    { skip: process.platform === "win32" },
    async () => {
      const server = createServer((_req, res) => {
        res.writeHead(200).end("ok");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      try {
        const svc = await ensureService(
          {
            id: "fake",
            label: "fake",
            command: ["false"],
            cwd: process.cwd(),
            env: {},
            healthUrl: `http://127.0.0.1:${port}/health`,
            healthMode: "http-ok",
            skipIfHealthy: true,
          },
          { quietConsole: true },
        );
        assert.equal(svc.external, true);
        // The listener is this very test process.
        assert.equal(svc.pid, process.pid);
      } finally {
        server.close();
      }
    },
  );
});
