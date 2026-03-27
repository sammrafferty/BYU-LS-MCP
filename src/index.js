#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdapter } from "./data/adapter.js";
import { isAuthAvailable } from "./auth/state.js";
import { registerTools } from "./tools/index.js";

let dataSource;

if (isAuthAvailable()) {
  const { createScraperDataSource } = await import("./data/scraperAdapter.js");
  dataSource = await createScraperDataSource();
  console.error("[LS-MCP] Using live scraper (auth-state.json found)");
} else {
  const { mockDataSource } = await import("./data/mockAdapter.js");
  dataSource = mockDataSource;
  console.error("[LS-MCP] Using mock data (no auth-state.json — run 'npm run auth' to connect)");
}

const data = createAdapter(dataSource);

const server = new McpServer({
  name: "BYU Learning Suite",
  version: "1.0.0",
});

registerTools(server, data);

const transport = new StdioServerTransport();
await server.connect(transport);
