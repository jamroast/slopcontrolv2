import "./load-env.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "@slopcontrol/types";
import {
  createSlopcontrolMcpServer,
  defaultSlopcontrolServerUrl,
} from "./mcp-tools.js";

const serverUrl = defaultSlopcontrolServerUrl();
const server = createSlopcontrolMcpServer({ serverUrl });

log.info("mcp", "stdio server starting", { serverUrl });
const transport = new StdioServerTransport();
await server.connect(transport);
log.info("mcp", "stdio server connected");
