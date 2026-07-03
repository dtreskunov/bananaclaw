import type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from './types.js';

/**
 * Shared MCP request-timeout default (ms). Governs connect, tools/list, and
 * tools/call. 60s matches OpenCode's native tool-call default. Set
 * MCP_TOOL_TIMEOUT in the host env to change it for every server across both
 * providers (single shared knob). A per-server `timeout` in the MCP config
 * overrides the env/default for that server.
 */
const DEFAULT_MCP_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT) || 60_000;

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
  timeout: number;
};

/** OpenCode `mcp` entry shape (remote HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
  timeout: number;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

function isRemote(cfg: McpServerConfig): cfg is McpHttpServerConfig {
  return cfg.type === 'http' || cfg.type === 'sse';
}

/**
 * Map NanoClaw v2 MCP definitions (same shape as Claude Agent SDK) into
 * OpenCode config `mcp` field. Supports stdio (local) and http/sse (remote).
 */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers) as Array<[string, McpServerConfig]>) {
    const timeout = cfg.timeout ?? DEFAULT_MCP_TIMEOUT_MS;
    if (isRemote(cfg)) {
      out[name] = {
        type: 'remote',
        url: cfg.url,
        ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
        enabled: true,
        timeout,
      };
      continue;
    }
    const stdio: McpStdioServerConfig = cfg;
    const env = stdio.env;
    out[name] = {
      type: 'local',
      command: [stdio.command, ...(stdio.args ?? [])],
      ...(env && Object.keys(env).length > 0 ? { environment: env } : {}),
      enabled: true,
      timeout,
    };
  }
  return out;
}
