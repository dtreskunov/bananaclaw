/** Model-facing names for external MCP tools; kept free of MCP SDK imports. */
export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function mcpToolPrefix(server: string): string {
  return `mcp__${sanitizeMcpName(server)}__`;
}
