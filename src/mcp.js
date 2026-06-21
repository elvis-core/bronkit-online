// Builds an MCP Server instance bound to ONE user's context (their decrypted
// JWK-backed client + workspace id). A fresh instance is created per HTTP request
// so each tool call uses only the caller's credentials — users never mix.
//
// The tool catalogue, annotations, and the always-on `instructions` are ported
// verbatim from local bronkit; only the dispatch host changes (stdio -> the SDK's
// request handlers). Tool behaviour is identical.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools, toolsByName } from "./tools/index.js";
import { INSTRUCTIONS } from "./instructions.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function toolList() {
  return tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
  }));
}

/**
 * @param {{ client: import('./api/client.js').BronApiClient, workspaceId: string }} ctx
 * @returns {Server}
 */
export function buildServer(ctx) {
  const server = new Server(
    { name: "bronkit", title: "Bronkit", version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      const data = await tool.handler(ctx, req.params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  return server;
}
