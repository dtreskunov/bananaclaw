/**
 * MCP server bootstrap.
 *
 * Tool self-registration lives in `tool-registry.ts` so in-process callers
 * (the `native` provider) can dispatch tools without loading the MCP server
 * SDK. This module is only reached by the stdio sidecar (`index.ts`).
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { invokeRegisteredTool, listRegisteredTools } from './tool-registry.js';

// Re-exported so tool modules added by skills can keep importing from here.
export { invokeRegisteredTool, listRegisteredTools, registerTools } from './tool-registry.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  const allTools = listRegisteredTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return invokeRegisteredTool(name, args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
