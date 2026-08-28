import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from 'ai';

import type { McpServerConfig } from '../types.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT) || 60_000;

interface Connection {
  client: Client;
  timeout: number;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function createTransport(config: McpServerConfig, cwd: string): Transport {
  if (config.type === 'http' || config.type === 'sse') {
    const headers = config.headers ? { headers: config.headers } : undefined;
    const fetchWithHeaders: FetchLike = (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), ...(config.headers ?? {}) },
      });
    return config.type === 'sse'
      ? new SSEClientTransport(new URL(config.url), { requestInit: headers, fetch: fetchWithHeaders })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: headers });
  }

  const stdio = config as Extract<McpServerConfig, { type?: 'stdio' }>;
  const transport = new StdioClientTransport({
    command: stdio.command,
    args: stdio.args,
    env: { ...inheritedEnvironment(), ...(stdio.env ?? {}) },
    cwd,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  return transport;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function contentOutput(result: CallToolResult) {
  if (result.isError) {
    const message = result.content
      .filter((part): part is Extract<(typeof result.content)[number], { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    return { type: 'error-text' as const, value: message || 'MCP tool failed' };
  }
  const value: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; data: { type: 'data'; data: string }; mediaType: string; filename?: string }
  > = [];
  for (const part of result.content) {
    if (part.type === 'text') {
      value.push({ type: 'text', text: part.text });
    } else if (part.type === 'image' || part.type === 'audio') {
      value.push({
        type: 'file',
        data: { type: 'data', data: part.data },
        mediaType: part.mimeType,
      });
    } else if (part.type === 'resource') {
      if ('text' in part.resource) {
        value.push({ type: 'text', text: `[resource: ${part.resource.uri}]\n${part.resource.text}` });
      } else {
        value.push({
          type: 'file',
          data: { type: 'data', data: part.resource.blob },
          mediaType: part.resource.mimeType ?? 'application/octet-stream',
          filename: part.resource.uri.split('/').pop(),
        });
      }
    } else if (part.type === 'resource_link') {
      value.push({ type: 'text', text: `[resource: ${part.name}](${part.uri})` });
    }
  }
  if (value.length === 0 && result.structuredContent) {
    return result.isError
      ? { type: 'error-json' as const, value: result.structuredContent as never }
      : { type: 'json' as const, value: result.structuredContent as never };
  }
  return { type: 'content' as const, value };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s'"<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        return url.toString();
      } catch {
        return '[redacted-url]';
      }
    })
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

export class NativeMcpManager {
  private readonly connections: Connection[] = [];
  private toolsPromise: Promise<ToolSet> | null = null;
  private closed = false;

  constructor(
    private readonly servers: Record<string, McpServerConfig> = {},
    private readonly cwd = '/workspace/agent',
  ) {}

  tools(signal?: AbortSignal): Promise<ToolSet> {
    this.toolsPromise ??= this.discoverTools(signal);
    return this.toolsPromise;
  }

  async close(): Promise<void> {
    this.closed = true;
    const connections = this.connections.splice(0);
    await Promise.all(connections.map(({ client }) => client.close().catch(() => {})));
  }

  private async discoverTools(signal?: AbortSignal): Promise<ToolSet> {
    const toolSets = await Promise.all(
      Object.entries(this.servers).map(async ([serverName, config]) => {
        const client = new Client({ name: `nanoclaw-native-${sanitizeName(serverName)}`, version: '1.0.0' });
        const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
        try {
          await client.connect(createTransport(config, this.cwd), { timeout, signal });
          const definitions = [];
          let cursor: string | undefined;
          do {
            const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout, signal });
            definitions.push(...listed.tools);
            cursor = listed.nextCursor;
          } while (cursor);
          if (this.closed || signal?.aborted) {
            await client.close().catch(() => {});
            return {};
          }
          this.connections.push({ client, timeout });
          const tools: ToolSet = {};
          for (const definition of definitions) {
            const exposedName = `mcp__${sanitizeName(serverName)}__${sanitizeName(definition.name)}`;
            if (tools[exposedName]) throw new Error(`MCP tool name collision in ${serverName}: ${exposedName}`);
            tools[exposedName] = dynamicTool({
              description: definition.description ?? `${definition.name} from ${serverName}`,
              inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
              execute: async (input, options) => {
                const result = await client.callTool(
                  { name: definition.name, arguments: input as Record<string, unknown> },
                  undefined,
                  { timeout, signal: options.abortSignal, resetTimeoutOnProgress: true },
                );
                if ('toolResult' in result) return result.toolResult;
                return result as CallToolResult;
              },
              toModelOutput: ({ output }) =>
                output && typeof output === 'object' && 'content' in output
                  ? contentOutput(output as CallToolResult)
                  : { type: 'json' as const, value: output as never },
            });
          }
          return tools;
        } catch (error) {
          await client.close().catch(() => {});
          console.error(`[native-mcp] Skipping ${serverName}: ${errorMessage(error)}`);
          return {};
        }
      }),
    );

    const merged: ToolSet = {};
    for (const tools of toolSets) {
      for (const [name, definition] of Object.entries(tools)) {
        if (merged[name]) throw new Error(`External MCP tool name collision: ${name}`);
        merged[name] = definition;
      }
    }
    return merged;
  }
}
