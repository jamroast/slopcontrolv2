import type { Express, NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "@slopcontrol/types";
import {
  createSlopcontrolMcpServer,
  defaultSlopcontrolServerUrl,
} from "./mcp-tools.js";

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

function optionalMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.SLOPCONTROL_MCP_TOKEN;
  if (!token) {
    next();
    return;
  }
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) {
    next();
    return;
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Unauthorized",
    },
    id: null,
  });
}

/**
 * Mount Streamable HTTP MCP at `/mcp` (stateless: one server+transport per POST).
 */
export function mountMcpHttp(app: Express): void {
  const serverUrl = defaultSlopcontrolServerUrl();

  app.post("/mcp", optionalMcpAuth, async (req, res) => {
    const server = createSlopcontrolMcpServer({ serverUrl });
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("mcp", "streamable HTTP request failed", { error: message });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", optionalMcpAuth, (_req, res) => {
    jsonRpcError(res, 405, "Method not allowed.");
  });

  app.delete("/mcp", optionalMcpAuth, (_req, res) => {
    jsonRpcError(res, 405, "Method not allowed.");
  });

  log.info("mcp", "streamable HTTP mounted", {
    path: "/mcp",
    serverUrl,
    auth: Boolean(process.env.SLOPCONTROL_MCP_TOKEN),
  });
}
