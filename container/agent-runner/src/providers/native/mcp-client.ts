import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool, type ToolSet } from 'ai';

import type { McpServerConfig } from '../types.js';
import { mcpToolPrefix, sanitizeMcpName } from './mcp-names.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT) || 60_000;

interface Connection {
  client: Client;
  timeout: number;
}

/** One discovered external MCP tool, as exposed to the model. */
export interface McpToolEntry {
  /** Model-facing name: `mcp__<server>__<tool>`. */
  name: string;
  server: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  tool: Tool;
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
  private entriesPromise: Promise<McpToolEntry[]> | null = null;
  private closed = false;

  constructor(
    private readonly servers: Record<string, McpServerConfig> = {},
    private readonly cwd = '/workspace/agent',
  ) {}

  entries(signal?: AbortSignal): Promise<McpToolEntry[]> {
    this.entriesPromise ??= this.discoverTools(signal);
    return this.entriesPromise;
  }

  async tools(signal?: AbortSignal): Promise<ToolSet> {
    return Object.fromEntries((await this.entries(signal)).map((entry) => [entry.name, entry.tool]));
  }

  async close(): Promise<void> {
    this.closed = true;
    const connections = this.connections.splice(0);
    await Promise.all(connections.map(({ client }) => client.close().catch(() => {})));
  }

  private async discoverTools(signal?: AbortSignal): Promise<McpToolEntry[]> {
    const toolSets = await Promise.all(
      Object.entries(this.servers).map(async ([serverName, config]) => {
        const client = new Client({ name: `nanoclaw-native-${sanitizeMcpName(serverName)}`, version: '1.0.0' });
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
            return [];
          }
          this.connections.push({ client, timeout });
          const entries = new Map<string, McpToolEntry>();
          for (const definition of definitions) {
            const exposedName = `${mcpToolPrefix(serverName)}${sanitizeMcpName(definition.name)}`;
            if (entries.has(exposedName)) throw new Error(`MCP tool name collision in ${serverName}: ${exposedName}`);
            const description = definition.description ?? `${definition.name} from ${serverName}`;
            const tool = dynamicTool({
              description,
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
            entries.set(exposedName, {
              name: exposedName,
              server: serverName,
              toolName: definition.name,
              description,
              inputSchema: definition.inputSchema,
              tool,
            });
          }
          return [...entries.values()];
        } catch (error) {
          await client.close().catch(() => {});
          console.error(`[native-mcp] Skipping ${serverName}: ${errorMessage(error)}`);
          return [];
        }
      }),
    );

    const merged = new Map<string, McpToolEntry>();
    for (const entry of toolSets.flat()) {
      if (merged.has(entry.name)) throw new Error(`External MCP tool name collision: ${entry.name}`);
      merged.set(entry.name, entry);
    }
    return [...merged.values()];
  }
}
