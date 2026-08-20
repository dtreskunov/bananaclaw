import { describe, expect, it } from 'bun:test';
import { forwardToUpstream, startFxMcpShims } from './fx-mcp-shim.js';
import { mcpServersToFxConfig } from './mcp-to-fx.js';

describe('startFxMcpShims', () => {
  it('gives each remote server a loopback URL that keeps the upstream path', () => {
    const shims = startFxMcpShims({
      Apify: { type: 'http', url: 'https://mcp.apify.com' },
      Tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp' },
    });
    try {
      expect(shims.urlFor('Apify')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(shims.urlFor('Tavily')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      // Distinct ports: the SSE transport routes by origin, so servers cannot
      // share a listener.
      expect(shims.urlFor('Apify')).not.toBe(shims.urlFor('Tavily'));
    } finally {
      shims.stop();
    }
  });

  it('leaves stdio and already-loopback servers alone', () => {
    const shims = startFxMcpShims({
      local: { command: 'bun', args: ['x'] },
      inContainer: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
    });
    try {
      expect(shims.urlFor('local')).toBeUndefined();
      expect(shims.urlFor('inContainer')).toBeUndefined();
    } finally {
      shims.stop();
    }
  });

  it('forwards method, path, query, body and response headers to the upstream', async () => {
    let seen: { method: string; path: string; body: string; header: string | null } | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen = {
          method: req.method,
          path: `${url.pathname}${url.search}`,
          body: await req.text(),
          header: req.headers.get('mcp-protocol-version'),
        };
        return new Response('{"ok":true}', { headers: { 'mcp-session-id': 'sess-1' } });
      },
    });
    try {
      const res = await forwardToUpstream(
        'remote',
        `http://127.0.0.1:${upstream.port}`,
        new Request('http://127.0.0.1:1/mcp?workspace=one', {
          method: 'POST',
          headers: { 'mcp-protocol-version': '2025-06-18' },
          body: '{"jsonrpc":"2.0"}',
        }),
        undefined,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBe('sess-1');
      expect(seen).toEqual({
        method: 'POST',
        path: '/mcp?workspace=one',
        body: '{"jsonrpc":"2.0"}',
        header: '2025-06-18',
      });
    } finally {
      upstream.stop(true);
    }
  });

  it('reports a shim failure as 502 rather than hanging fx', async () => {
    const res = await forwardToUpstream(
      'dead',
      'http://unreachable.invalid:1',
      new Request('http://127.0.0.1:1/mcp', { method: 'POST', body: '{}' }),
      undefined,
    );
    expect(res.status).toBe(502);
  });
});

describe('mcpServersToFxConfig with shims', () => {
  it('advertises the loopback URL when one exists and the real URL otherwise', () => {
    const out = mcpServersToFxConfig(
      {
        Apify: { type: 'http', url: 'https://mcp.apify.com' },
        Direct: { type: 'sse', url: 'https://mcp.example.com/sse' },
      },
      undefined,
      (name) => (name === 'Apify' ? 'http://127.0.0.1:5555' : undefined),
    );
    expect(out).toEqual([
      { type: 'http', name: 'Apify', url: 'http://127.0.0.1:5555', headers: [] },
      { type: 'sse', name: 'Direct', url: 'https://mcp.example.com/sse', headers: [] },
    ]);
  });
});
