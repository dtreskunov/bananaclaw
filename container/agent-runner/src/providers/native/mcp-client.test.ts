import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { NativeMcpManager } from './mcp-client.js';

const managers: NativeMcpManager[] = [];
const httpServers: HttpServer[] = [];
const bunServers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(
    httpServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const server of bunServers.splice(0)) server.stop(true);
});

function server(): Server {
  const instance = new Server({ name: 'native-http-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  instance.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'remote_echo', description: 'Echo remotely.', inputSchema: { type: 'object', properties: {} } }],
  }));
  instance.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text', text: 'remote:ok' }],
  }));
  return instance;
}

async function execute(
  tools: Awaited<ReturnType<NativeMcpManager['tools']>>,
  name: string,
  input: unknown,
  abortSignal?: AbortSignal,
) {
  const external = tools[name] as {
    execute?: (
      input: unknown,
      options: { abortSignal?: AbortSignal; context: object; messages: never[]; toolCallId: string },
    ) => unknown;
  };
  if (!external?.execute) throw new Error(`Missing external MCP tool: ${name}`);
  return external.execute(input, { context: {}, messages: [], toolCallId: 'call-1', abortSignal });
}

describe('NativeMcpManager', () => {
  it('discovers and invokes a stdio MCP tool', async () => {
    const fixture = path.join(import.meta.dir, 'test-fixtures', 'stdio-mcp.ts');
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    const manager = new NativeMcpManager({ Fixture: { command: bun, args: ['run', fixture] } }, process.cwd());
    managers.push(manager);

    const tools = await manager.tools();
    const external = tools.mcp__Fixture__echo_value as {
      execute?: (
        input: unknown,
        options: { abortSignal?: AbortSignal; context: object; messages: never[]; toolCallId: string },
      ) => unknown;
      toModelOutput?: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
    };
    expect(external).toBeDefined();
    const output = await external.execute?.({ value: 'hello' }, { context: {}, messages: [], toolCallId: 'call-1' });
    expect(output).toEqual({ content: [{ type: 'text', text: 'echo:hello' }] });
    expect(external.toModelOutput?.({ input: { value: 'hello' }, output, toolCallId: 'call-1' })).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'echo:hello' }],
    });

    const imageTool = tools.mcp__Fixture__image as {
      execute?: (input: unknown, options: { context: object; messages: never[]; toolCallId: string }) => unknown;
      toModelOutput?: (options: { input: unknown; output: unknown; toolCallId: string }) => unknown;
    };
    const image = await imageTool.execute?.({}, { context: {}, messages: [], toolCallId: 'call-2' });
    expect(imageTool.toModelOutput?.({ input: {}, output: image, toolCallId: 'call-2' })).toEqual({
      type: 'content',
      value: [{ type: 'file', data: { type: 'data', data: 'AQID' }, mediaType: 'image/png' }],
    });
  });

  it('discovers and invokes a Streamable HTTP MCP tool', async () => {
    const web = Bun.serve({
      port: 0,
      async fetch(request) {
        const transport = new WebStandardStreamableHTTPServerTransport();
        await server().connect(transport);
        return transport.handleRequest(request);
      },
    });
    bunServers.push(web);
    const manager = new NativeMcpManager({ Remote: { type: 'http', url: `http://127.0.0.1:${web.port}/mcp` } });
    managers.push(manager);

    expect(await execute(await manager.tools(), 'mcp__Remote__remote_echo', {})).toEqual({
      content: [{ type: 'text', text: 'remote:ok' }],
    });
  });

  it('discovers and invokes a legacy SSE MCP tool', async () => {
    let transport: SSEServerTransport | undefined;
    const http = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/sse') {
        transport = new SSEServerTransport('/messages', response);
        await server().connect(transport);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/messages' && transport) {
        await transport.handlePostMessage(request, response);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    httpServers.push(http);
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('SSE fixture failed to bind');
    const manager = new NativeMcpManager({ Legacy: { type: 'sse', url: `http://127.0.0.1:${address.port}/sse` } });
    managers.push(manager);

    expect(await execute(await manager.tools(), 'mcp__Legacy__remote_echo', {})).toEqual({
      content: [{ type: 'text', text: 'remote:ok' }],
    });
  });

  it('isolates a failed server and enforces per-server timeouts', async () => {
    const fixture = path.join(import.meta.dir, 'test-fixtures', 'stdio-mcp.ts');
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    const manager = new NativeMcpManager(
      {
        Broken: { command: '/definitely/missing/mcp' },
        Fixture: { command: bun, args: ['run', fixture], timeout: 500 },
      },
      process.cwd(),
    );
    managers.push(manager);
    const tools = await manager.tools();

    expect(tools.mcp__Fixture__echo_value).toBeDefined();
    expect(tools.mcp__Broken__anything).toBeUndefined();
    expect(execute(tools, 'mcp__Fixture__wait', { ms: 1_000 })).rejects.toThrow();
  });

  it('propagates abort signals to in-flight MCP calls', async () => {
    const fixture = path.join(import.meta.dir, 'test-fixtures', 'stdio-mcp.ts');
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    const manager = new NativeMcpManager(
      { Fixture: { command: bun, args: ['run', fixture], timeout: 5_000 } },
      process.cwd(),
    );
    managers.push(manager);
    const controller = new AbortController();
    const pending = execute(await manager.tools(), 'mcp__Fixture__wait', { ms: 1_000 }, controller.signal);
    controller.abort();
    expect(pending).rejects.toThrow();
  });

  it('aborts MCP discovery without retaining a late connection', async () => {
    const hanging = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return new Response(null, { status: 500 });
      },
    });
    bunServers.push(hanging);
    const manager = new NativeMcpManager({
      Hanging: { type: 'http', url: `http://127.0.0.1:${hanging.port}/mcp`, timeout: 10_000 },
    });
    managers.push(manager);
    const controller = new AbortController();
    const pending = manager.tools(controller.signal);
    controller.abort();
    await manager.close();
    expect(await pending).toEqual({});
  });
});
