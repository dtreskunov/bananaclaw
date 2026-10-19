import { afterEach, describe, expect, it, spyOn } from 'bun:test';
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
  it('coalesces concurrent discovery per server and leaves unrelated servers untouched', async () => {
    let initializations = 0;
    const web = Bun.serve({
      port: 0,
      async fetch(request) {
        const message = request.method === 'POST' ? await request.clone().json() as { method?: string } : undefined;
        if (message?.method === 'initialize') initializations++;
        const transport = new WebStandardStreamableHTTPServerTransport();
        await server().connect(transport);
        return transport.handleRequest(request);
      },
    });
    bunServers.push(web);
    const manager = new NativeMcpManager({
      Remote: { type: 'http', url: `http://127.0.0.1:${web.port}/mcp` },
      Unrelated: { command: '/definitely/missing/unrelated-mcp' },
    });
    managers.push(manager);
    const [first, second] = await Promise.all([
      manager.entries(undefined, ['Remote'], true), manager.entries(undefined, ['Remote'], true),
    ]);
    expect(initializations).toBe(1);
    expect(first.map((entry) => entry.name)).toEqual(['mcp__Remote__remote_echo']);
    expect(second).toEqual(first);
    await manager.entries(undefined, ['Remote'], true);
    expect(initializations).toBe(1);
    await expect(manager.entries(undefined, ['Unrelated'], true)).rejects.toThrow('MCP discovery incomplete');
    expect(await manager.entries(undefined, ['Remote'], true)).toEqual(first);
  });

  it('does not cache failed discovery and reports complete paginated list timing without URLs or headers', async () => {
    let reject = true;
    let pages = 0;
    const logs: string[] = [];
    const logger = spyOn(console, 'error').mockImplementation((message) => { logs.push(String(message)); });
    const web = Bun.serve({
      port: 0,
      async fetch(request) {
        if (reject) return new Response('unavailable', { status: 503 });
        const instance = server();
        instance.setRequestHandler(ListToolsRequestSchema, async (request) => {
          pages++;
          const last = !!request.params?.cursor;
          return {
            tools: [{
              name: last ? 'last' : 'first', inputSchema: { type: 'object', properties: {} },
            }],
            ...(last ? {} : { nextCursor: 'next' }),
          };
        });
        const transport = new WebStandardStreamableHTTPServerTransport();
        await instance.connect(transport);
        return transport.handleRequest(request);
      },
    });
    bunServers.push(web);
    const manager = new NativeMcpManager({
      Remote: {
        type: 'http', url: `http://127.0.0.1:${web.port}/mcp?token=secret-value`,
        headers: { Authorization: 'Bearer credential-value' },
      },
    });
    managers.push(manager);
    try {
      await expect(manager.entries(undefined, ['Remote'], true)).rejects.toThrow('MCP discovery incomplete');
      reject = false;
      const entries = await manager.entries(undefined, ['Remote'], true);
      expect(entries).toHaveLength(2);
      expect(pages).toBe(2);
      const joined = logs.join('\n');
      expect(joined).toContain('"phase":"connect"');
      expect(joined).toContain('"phase":"tools/list"');
      expect(joined).toContain('"tools":2');
      expect(joined).not.toContain('secret-value');
      expect(joined).not.toContain('credential-value');
    } finally {
      logger.mockRestore();
    }
  });

  it('closing the manager aborts pending discovery even without a caller abort signal', async () => {
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const web = Bun.serve({
      port: 0,
      async fetch() {
        started();
        return new Promise<Response>(() => {});
      },
    });
    bunServers.push(web);
    const manager = new NativeMcpManager({
      Hanging: { type: 'http', url: `http://127.0.0.1:${web.port}/mcp`, timeout: 5000 },
    });
    managers.push(manager);
    const pending = manager.entries(undefined, ['Hanging'], true).catch((error: unknown) => error);
    await requested;
    await manager.close();
    expect(await pending).toMatchObject({ message: expect.stringContaining('MCP discovery incomplete') });
    await expect(manager.entries()).rejects.toThrow('MCP manager is closed');
  });

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

  it('re-initializes and retries when a Streamable HTTP session expires', async () => {
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    let expireSession = false;
    let initializationCount = 0;
    const web = Bun.serve({
      port: 0,
      async fetch(request) {
        const sessionId = request.headers.get('mcp-session-id');
        if (sessionId) {
          const transport = sessions.get(sessionId);
          if (!transport || expireSession) {
            expireSession = false;
            sessions.delete(sessionId);
            return new Response('expired transport state', { status: 404 });
          }
          return transport.handleRequest(request);
        }

        initializationCount += 1;
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => `session-${initializationCount}`,
          onsessioninitialized: (id) => sessions.set(id, transport),
        });
        await server().connect(transport);
        return transport.handleRequest(request);
      },
    });
    bunServers.push(web);
    const manager = new NativeMcpManager({ Remote: { type: 'http', url: `http://127.0.0.1:${web.port}/mcp` } });
    managers.push(manager);

    const tools = await manager.tools();
    expireSession = true;
    expect(await execute(tools, 'mcp__Remote__remote_echo', {})).toEqual({
      content: [{ type: 'text', text: 'remote:ok' }],
    });
    expect(initializationCount).toBe(2);
  });

  it('does not re-initialize a sessionless Streamable HTTP connection on 404', async () => {
    let rejectCalls = false;
    let initializationCount = 0;
    const web = Bun.serve({
      port: 0,
      async fetch(request) {
        const message = request.method === 'POST'
          ? await request.clone().json() as { method?: string }
          : undefined;
        if (message?.method === 'initialize') initializationCount += 1;
        if (rejectCalls && message?.method === 'tools/call') {
          return new Response('ordinary missing resource', { status: 404 });
        }
        const transport = new WebStandardStreamableHTTPServerTransport();
        await server().connect(transport);
        return transport.handleRequest(request);
      },
    });
    bunServers.push(web);
    const manager = new NativeMcpManager({ Remote: { type: 'http', url: `http://127.0.0.1:${web.port}/mcp` } });
    managers.push(manager);

    const tools = await manager.tools();
    rejectCalls = true;
    expect(execute(tools, 'mcp__Remote__remote_echo', {})).rejects.toThrow('ordinary missing resource');
    expect(initializationCount).toBe(1);
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

  it('cancels only one MCP request and keeps its sibling and shared connection usable', async () => {
    const fixture = path.join(import.meta.dir, 'test-fixtures', 'stdio-mcp.ts');
    const bun = Bun.which('bun');
    if (!bun) throw new Error('bun executable not found');
    const manager = new NativeMcpManager({ Fixture: { command: bun, args: ['run', fixture], timeout: 5000 } }, process.cwd());
    managers.push(manager);
    const tools = await manager.tools();
    const controller = new AbortController();
    const target = Promise.resolve(execute(tools, 'mcp__Fixture__wait', { ms: 1000 }, controller.signal))
      .catch((error: unknown) => error);
    const sibling = execute(tools, 'mcp__Fixture__wait', { ms: 20 });
    controller.abort(new Error('Stop only this tool'));
    expect(await target).toBeInstanceOf(Error);
    expect(await sibling).toEqual({ content: [{ type: 'text', text: 'waited' }] });
    expect(await execute(tools, 'mcp__Fixture__echo_value', { value: 'still connected' }))
      .toEqual({ content: [{ type: 'text', text: 'echo:still connected' }] });
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
