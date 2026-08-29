/**
 * In-process tool registry — the tool map plus register/list/invoke.
 *
 * Split out of `server.ts` so callers that dispatch tools directly instead of
 * speaking MCP (the `native` provider, via `native/tools.ts`) don't drag
 * `@modelcontextprotocol/sdk/server` into their process. The only MCP import
 * here is type-only, so it costs nothing at runtime.
 *
 * Tool modules call `registerTools([...])` at import time; the barrel
 * (`registry.ts`) imports every tool module for those side effects.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      console.error(`[mcp-tools] Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export function listRegisteredTools(): McpToolDefinition[] {
  return [...allTools];
}

export async function invokeRegisteredTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  return tool.handler(args);
}
