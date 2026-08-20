/**
 * Translate NanoClaw's MCP server map into the `mcpServers` array that fx's
 * ACP `session/new` expects.
 *
 * fx validates this payload strictly, and more strictly than NanoClaw's own
 * types imply (see src/acp/mcp_servers.zig):
 *   - stdio entries require `command`, `args` AND `env` — all three, even when
 *     empty — and `command` must be an absolute executable path.
 *   - http/sse entries require `url` and `headers`, and the url must be HTTPS
 *     or an explicit loopback HTTP endpoint.
 *   - `env` and `headers` are arrays of {name, value}, not objects.
 *
 * NanoClaw's `McpServerConfig` makes args/env optional and allows a bare
 * command name, so this is a real conversion rather than a rename.
 */
import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from './types.js';

export type FxMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: 'http' | 'sse'; name: string; url: string; headers: Array<{ name: string; value: string }> };

function toNameValue(record: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * fx rejects a non-absolute MCP command outright, so resolve bare names
 * against PATH here rather than letting the session fail to start.
 */
export function resolveCommandPath(command: string, pathEnv = process.env.PATH ?? ''): string {
  if (path.isAbsolute(command)) return command;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return command;
}

export function mcpServersToFxConfig(
  servers: Record<string, McpServerConfig> | undefined,
  resolve: (command: string) => string = resolveCommandPath,
): FxMcpServer[] {
  const out: FxMcpServer[] = [];
  for (const [name, config] of Object.entries(servers ?? {})) {
    if ('url' in config) {
      out.push({
        type: config.type === 'sse' ? 'sse' : 'http',
        name,
        url: config.url,
        headers: toNameValue(config.headers),
      });
      continue;
    }
    out.push({
      name,
      command: resolve(config.command),
      args: config.args ?? [],
      env: toNameValue(config.env),
    });
  }
  return out;
}
