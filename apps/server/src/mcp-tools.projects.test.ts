import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import {
  dispatchSlopcontrolTool,
  SLOPCONTROL_MCP_TOOLS,
  type SlopcontrolToolResult,
} from "./mcp-tools.js";
import { createStore } from "./store.js";

const serverUrl = "http://127.0.0.1:3999";

function mockFetch(
  handler: (url: string) => { ok?: boolean; body: string },
) {
  return mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    const { ok = true, body } = handler(url);
    return { ok, text: async () => body };
  });
}

function textOf(result: SlopcontrolToolResult): string {
  return result.content[0]?.text ?? "";
}

describe("list_projects MCP tool", () => {
  it("dispatches an empty-arg call to GET /projects and returns the projects payload", async () => {
    const projects = [
      {
        id: "p1",
        name: "Alpha",
        rootPath: "/tmp/alpha",
        buildProcessConfigured: true,
        codingToolId: "pi",
        askInvestigateTool: "auto",
      },
    ];
    const fetchMock = mockFetch((url) => {
      assert.match(url, /\/projects$/);
      return { body: JSON.stringify({ projects }) };
    });
    try {
      const result = await dispatchSlopcontrolTool(
        "list_projects",
        {},
        { serverUrl },
      );
      assert.equal(result.isError, false);
      const payload = JSON.parse(textOf(result)) as {
        projects: { id: string; name: string; rootPath: string }[];
      };
      assert.ok(Array.isArray(payload.projects));
      assert.ok(payload.projects.length > 0);
      for (const project of payload.projects) {
        assert.ok(project.id);
        assert.ok(project.name);
        assert.ok(project.rootPath);
      }
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("reports the same project count as get_health on one live store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcontrol-list-projects-"));
    const previous = process.env.SLOPCONTROL_DATA_DIR;
    process.env.SLOPCONTROL_DATA_DIR = dir;
    const cleanup = () => {
      if (previous === undefined) {
        delete process.env.SLOPCONTROL_DATA_DIR;
      } else {
        process.env.SLOPCONTROL_DATA_DIR = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    };
    try {
      const store = createStore();
      const total = 3;
      for (let i = 0; i < total; i += 1) {
        store.createProject({
          name: `Project ${i}`,
          rootPath: join(dir, `project-${i}`),
        });
      }

      const fetchMock = mockFetch((url) => {
        if (/\/health$/.test(url)) {
          return { body: JSON.stringify({ projects: store.listProjects().length }) };
        }
        if (/\/projects$/.test(url)) {
          return { body: JSON.stringify({ projects: store.listProjects() }) };
        }
        return { ok: false, body: "unexpected url" };
      });
      try {
        const health = await dispatchSlopcontrolTool(
          "get_health",
          {},
          { serverUrl },
        );
        const list = await dispatchSlopcontrolTool(
          "list_projects",
          {},
          { serverUrl },
        );
        // get_health's dispatch branch omits isError entirely (existing behaviour),
        // so an absent flag means success; list_projects sets it explicitly.
        assert.equal(health.isError ?? false, false);
        assert.equal(list.isError, false);

        const healthPayload = JSON.parse(textOf(health)) as { projects: number };
        const listPayload = JSON.parse(textOf(list)) as {
          projects: unknown[];
        };
        assert.equal(listPayload.projects.length, healthPayload.projects);
        assert.equal(listPayload.projects.length, total);
      } finally {
        fetchMock.mock.restore();
      }
    } finally {
      cleanup();
    }
  });

  it("registers list_projects with an empty input schema", () => {
    const tool = SLOPCONTROL_MCP_TOOLS.find((t) => t.name === "list_projects");
    assert.ok(tool, "list_projects is not registered in SLOPCONTROL_MCP_TOOLS");
    const schema = tool.inputSchema as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    const required = schema.required ?? [];
    assert.equal(required.length, 0);
    assert.deepEqual(schema.properties, {});
  });
});
