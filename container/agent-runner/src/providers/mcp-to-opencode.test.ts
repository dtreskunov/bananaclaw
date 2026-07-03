import { describe, it, expect } from 'bun:test';

import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';

describe('mcpServersToOpenCodeConfig', () => {
  it('maps nanoclaw + extra server like v2 index.ts merge', () => {
    const servers = {
      nanoclaw: {
        command: 'node',
        args: ['/app/src/mcp-tools/index.js'],
        env: {
          SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
          SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
          SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
        },
      },
      extra: {
        command: 'npx',
        args: ['-y', 'some-mcp'],
        env: { FOO: 'bar' },
      },
    };

    const mcp = mcpServersToOpenCodeConfig(servers);

    expect(mcp.nanoclaw).toEqual({
      type: 'local',
      command: ['node', '/app/src/mcp-tools/index.js'],
      environment: {
        SESSION_INBOUND_DB_PATH: '/workspace/inbound.db',
        SESSION_OUTBOUND_DB_PATH: '/workspace/outbound.db',
        SESSION_HEARTBEAT_PATH: '/workspace/.heartbeat',
      },
      enabled: true,
      timeout: 60_000,
    });

    expect(mcp.extra).toEqual({
      type: 'local',
      command: ['npx', '-y', 'some-mcp'],
      environment: { FOO: 'bar' },
      enabled: true,
      timeout: 60_000,
    });
  });

  it('omits environment when env is empty', () => {
    const mcp = mcpServersToOpenCodeConfig({
      x: { command: 'true', args: [], env: {} },
    });
    expect(mcp.x).toEqual({
      type: 'local',
      command: ['true'],
      enabled: true,
      timeout: 60_000,
    });
  });

  it('returns empty record for undefined', () => {
    expect(mcpServersToOpenCodeConfig(undefined)).toEqual({});
  });

  it('maps http remote server to OpenCode remote entry', () => {
    const mcp = mcpServersToOpenCodeConfig({
      tavily: {
        type: 'http',
        url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-test',
        headers: { Authorization: 'Bearer tvly-test' },
      },
    });
    expect(mcp.tavily).toEqual({
      type: 'remote',
      url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-test',
      headers: { Authorization: 'Bearer tvly-test' },
      enabled: true,
      timeout: 60_000,
    });
  });

  it('maps sse remote server without headers', () => {
    const mcp = mcpServersToOpenCodeConfig({
      remote: { type: 'sse', url: 'https://example.com/sse' },
    });
    expect(mcp.remote).toEqual({
      type: 'remote',
      url: 'https://example.com/sse',
      enabled: true,
      timeout: 60_000,
    });
  });

  it('treats absent type as stdio', () => {
    const mcp = mcpServersToOpenCodeConfig({
      legacy: { command: 'echo', args: ['hi'], env: {} },
    });
    expect(mcp.legacy).toEqual({
      type: 'local',
      command: ['echo', 'hi'],
      enabled: true,
      timeout: 60_000,
    });
  });

  it('honors a per-server timeout override', () => {
    const mcp = mcpServersToOpenCodeConfig({
      slow: { command: 'true', args: [], timeout: 180_000 },
      remote: { type: 'http', url: 'https://example.com/mcp', timeout: 240_000 },
    });
    expect(mcp.slow).toEqual({
      type: 'local',
      command: ['true'],
      enabled: true,
      timeout: 180_000,
    });
    expect(mcp.remote).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      enabled: true,
      timeout: 240_000,
    });
  });
});
