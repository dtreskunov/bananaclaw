import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { McpServerConfig } from './providers/types.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 30_000;
type ProbePhase = 'input' | 'connect' | 'tools/list';

interface ProbeSuccess {
  ok: true;
  latencyMs: number;
  serverInfo?: { name: string; version: string };
  tools: string[];
}

interface ProbeFailure {
  ok: false;
  latencyMs: number;
  phase: ProbePhase;
  error: string;
}

type ProbeResult = ProbeSuccess | ProbeFailure;

function emit(result: ProbeResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 1_000) || 'Unknown MCP error';
}

function requestTimeout(config: McpServerConfig): number {
  const configured = config.timeout ?? DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(configured, 1_000), MAX_TIMEOUT_MS);
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function createTransport(config: McpServerConfig): Transport {
  if (config.type === 'http' || config.type === 'sse') {
    const headers = config.headers ? { headers: config.headers } : undefined;
    const fetchWithHeaders: FetchLike = (input, init) => fetch(input, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), ...(config.headers ?? {}) },
    });
    const transport = config.type === 'sse'
      ? new SSEClientTransport(new URL(config.url), {
          requestInit: headers,
          fetch: fetchWithHeaders,
        })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: headers });
    return transport;
  }

  const stdio = config as Extract<McpServerConfig, { type?: 'stdio' }>;
  const transport = new StdioClientTransport({
    command: stdio.command,
    args: stdio.args,
    env: { ...inheritedEnvironment(), ...(stdio.env ?? {}) },
    cwd: '/workspace/agent',
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  return transport;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let phase: ProbePhase = 'input';
  let client: Client | undefined;

  try {
    const raw = await Bun.stdin.text();
    const config = JSON.parse(raw) as McpServerConfig;
    const transport = createTransport(config);
    client = new Client({ name: 'nanoclaw-mcp-probe', version: '1.0.0' });
    const timeout = requestTimeout(config);

    phase = 'connect';
    await client.connect(transport, { timeout });

    phase = 'tools/list';
    const result = await client.listTools(undefined, { timeout });
    const serverInfo = client.getServerVersion();
    emit({
      ok: true,
      latencyMs: Date.now() - startedAt,
      ...(serverInfo ? { serverInfo: { name: serverInfo.name, version: serverInfo.version } } : {}),
      tools: result.tools.map((tool) => tool.name),
    });
  } catch (error) {
    emit({
      ok: false,
      latencyMs: Date.now() - startedAt,
      phase,
      error: errorMessage(error),
    });
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => {});
  }
}

const hardStop = setTimeout(() => {
  emit({
    ok: false,
    latencyMs: MAX_TIMEOUT_MS + 5_000,
    phase: 'connect',
    error: 'MCP probe exceeded its hard timeout',
  });
  process.exit(124);
}, MAX_TIMEOUT_MS + 5_000);

main()
  .catch((error) => {
    emit({ ok: false, latencyMs: 0, phase: 'input', error: errorMessage(error) });
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(hardStop));