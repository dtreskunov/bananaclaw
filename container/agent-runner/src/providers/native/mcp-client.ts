import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool, type ToolSet } from 'ai';

import type { McpServerConfig } from '../types.js';
import { mcpToolPrefix, sanitizeMcpName } from './mcp-names.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT) || 60_000;

interface Connection {
  client: Client;
  config: McpServerConfig;
  serverName: string;
  timeout: number;
  transport: Transport;
  reconnecting?: Promise<void>;
}

interface DiscoveryResult {
  entries: McpToolEntry[];
  error?: string;
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

function isExpiredHttpSession(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

export class NativeMcpManager {
  private readonly connections: Connection[] = [];
  private readonly discoveries = new Map<string, Promise<DiscoveryResult>>();
  private readonly shutdown = new AbortController();
  private closed = false;

  constructor(
    private readonly servers: Record<string, McpServerConfig> = {},
    private readonly cwd = '/workspace/agent',
  ) {}

  async entries(signal?: AbortSignal, servers = Object.keys(this.servers), strict = false): Promise<McpToolEntry[]> {
    if (this.closed) throw new Error('MCP manager is closed');
    signal?.throwIfAborted();
    const results = await Promise.all(
      [...new Set(servers)].map((name) => {
        const config = this.servers[name];
        if (!config) throw new Error(`Unknown MCP server: ${name}`);
        let pending = this.discoveries.get(name);
        if (!pending) {
          const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
          pending = this.discoverServer(name, config, combined).then((result) => {
            if (result.error) this.discoveries.delete(name);
            return result;
          });
          this.discoveries.set(name, pending);
        }
        return pending;
      }),
    );
    if (strict) {
      signal?.throwIfAborted();
      const failures = results.flatMap((result) => (result.error ? [result.error] : []));
      if (failures.length) throw new Error(`MCP discovery incomplete: ${failures.join('; ')}`);
    }
    const merged = new Map<string, McpToolEntry>();
    for (const entry of results.flatMap((result) => result.entries)) {
      if (merged.has(entry.name)) throw new Error(`External MCP tool name collision: ${entry.name}`);
      merged.set(entry.name, entry);
    }
    return [...merged.values()];
  }

  async tools(signal?: AbortSignal): Promise<ToolSet> {
    return Object.fromEntries((await this.entries(signal)).map((entry) => [entry.name, entry.tool]));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort(new Error('MCP manager closed'));
    await Promise.all(this.discoveries.values());
    const connections = this.connections.splice(0);
    await Promise.all(connections.map(({ client }) => client.close().catch(() => {})));
  }

  private async reconnect(connection: Connection, failedClient: Client, signal?: AbortSignal): Promise<void> {
    if (connection.client !== failedClient) return;
    connection.reconnecting ??= (async () => {
      const replacement = new Client({
        name: `nanoclaw-native-${sanitizeMcpName(connection.serverName)}`,
        version: '1.0.0',
      });
      const replacementTransport = createTransport(connection.config, this.cwd);
      await replacement.connect(replacementTransport, {
        timeout: connection.timeout,
        signal,
      });
      if (this.closed) {
        await replacement.close().catch(() => {});
        throw new Error('MCP manager closed while reconnecting');
      }
      connection.client = replacement;
      connection.transport = replacementTransport;
      await failedClient.close().catch(() => {});
    })().finally(() => {
      connection.reconnecting = undefined;
    });
    await connection.reconnecting;
  }

  private async callTool(
    connection: Connection,
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const call = (client: Client) =>
      client.callTool({ name, arguments: input }, undefined, {
        timeout: connection.timeout,
        signal,
        resetTimeoutOnProgress: true,
      }) as Promise<CallToolResult>;
    const client = connection.client;
    try {
      return await call(client);
    } catch (error) {
      if (
        connection.config.type !== 'http' ||
        !(connection.transport instanceof StreamableHTTPClientTransport) ||
        !connection.transport.sessionId ||
        !isExpiredHttpSession(error)
      ) {
        throw error;
      }
      await this.reconnect(connection, client, signal);
      return call(connection.client);
    }
  }

  private async discoverServer(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal,
  ): Promise<DiscoveryResult> {
    const client = new Client({ name: `nanoclaw-native-${sanitizeMcpName(serverName)}`, version: '1.0.0' });
    const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    let phase = 'connect';
    let started = Date.now();
    const timing = (status: 'ok' | 'error', tools?: number) => {
      console.error(
        `[native-mcp] ${JSON.stringify({
          server: serverName,
          phase,
          durationMs: Date.now() - started,
          status,
          ...(tools !== undefined ? { tools } : {}),
        })}`,
      );
    };
    const cancel = () => {
      void client.close().catch((error) => {
        console.error(`[native-mcp] Could not close ${serverName}: ${errorMessage(error)}`);
      });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const transport = createTransport(config, this.cwd);
      await client.connect(transport, { timeout, signal });
      timing('ok');
      phase = 'tools/list';
      started = Date.now();
      const definitions = [];
      let cursor: string | undefined;
      do {
        const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout, signal });
        definitions.push(...listed.tools);
        cursor = listed.nextCursor;
      } while (cursor);
      timing('ok', definitions.length);
      phase = 'tools/build';
      started = Date.now();
      if (this.closed || signal?.aborted) {
        throw new Error('MCP discovery cancelled');
      }
      const connection: Connection = { client, config, serverName, timeout, transport };
      const entries = new Map<string, McpToolEntry>();
      for (const definition of definitions) {
        const exposedName = `${mcpToolPrefix(serverName)}${sanitizeMcpName(definition.name)}`;
        if (entries.has(exposedName)) throw new Error(`MCP tool name collision in ${serverName}: ${exposedName}`);
        const description = [definition.description ?? `${definition.name} from ${serverName}`,
          'instructions' in config ? config.instructions : undefined].filter(Boolean).join('\n');
        const tool = dynamicTool({
          description,
          inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
          execute: async (input, options) => {
            const result = await this.callTool(
              connection,
              definition.name,
              input as Record<string, unknown>,
              options.abortSignal,
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
      this.connections.push(connection);
      return { entries: [...entries.values()] };
    } catch (error) {
      timing('error');
      await client.close().catch(() => {});
      console.error(`[native-mcp] Skipping ${serverName}: ${errorMessage(error)}`);
      return { entries: [], error: `${serverName}: ${errorMessage(error)}` };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}
