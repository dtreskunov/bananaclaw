import { afterEach, describe, expect, test } from 'bun:test';

import {
  FX_CHAT_PATH,
  forwardableHeaders,
  forwardableResponseHeaders,
  redactProxy,
  scrubCredentials,
  startFxGatewayShim,
  summarizeUpstreamError,
  upstreamUrlFor,
} from './fx-gateway-shim.js';

describe('upstreamUrlFor', () => {
  test('maps the loopback path onto the gateway origin', () => {
    expect(upstreamUrlFor('http://127.0.0.1:5000/coding-agent/v1/models', 'https://ai-gateway.vercel.sh')).toBe(
      'https://ai-gateway.vercel.sh/coding-agent/v1/models',
    );
  });

  test('preserves the query string', () => {
    expect(upstreamUrlFor('http://127.0.0.1:5000/v1/models?a=1&b=2', 'https://gw.test')).toBe(
      'https://gw.test/v1/models?a=1&b=2',
    );
  });

  test('keeps a subpath prefix on a self-hosted upstream', () => {
    expect(upstreamUrlFor('http://127.0.0.1:5000/coding-agent/v1/models', 'https://gw.test/api/')).toBe(
      'https://gw.test/api/coding-agent/v1/models',
    );
  });
});

describe('forwardableHeaders', () => {
  test('drops hop-by-hop headers that must not be relayed', () => {
    const out = forwardableHeaders(
      new Headers({ host: 'x', connection: 'keep-alive', 'proxy-authorization': 'secret', accept: 'application/json' }),
    );
    expect(out.get('accept')).toBe('application/json');
    expect(out.get('host')).toBeNull();
    expect(out.get('connection')).toBeNull();
    expect(out.get('proxy-authorization')).toBeNull();
  });

  // fx sends a placeholder key that OneCLI swaps at the proxy, so the header
  // has to survive the hop.
  test('preserves Authorization so OneCLI can substitute the real credential', () => {
    expect(forwardableHeaders(new Headers({ authorization: 'Bearer placeholder' })).get('authorization')).toBe(
      'Bearer placeholder',
    );
  });
});

describe('forwardableResponseHeaders', () => {
  // Regression: fetch() already decompressed the body, so relaying the
  // upstream's content-encoding made the client inflate plain bytes and the
  // connection reset mid-response.
  test('strips content-encoding so the client does not double-decode', () => {
    const out = forwardableResponseHeaders(
      new Headers({ 'content-encoding': 'gzip', 'content-type': 'application/json' }),
    );
    expect(out.get('content-encoding')).toBeNull();
    expect(out.get('content-type')).toBe('application/json');
  });
});

describe('credential hygiene', () => {
  // The OneCLI proxy URL carries its gateway token as basic-auth userinfo.
  test('redactProxy hides the token but keeps the endpoint legible', () => {
    expect(redactProxy('http://x:aoc_supersecret@debian:10255')).toBe('http://***@debian:10255/');
    expect(redactProxy(undefined)).toBe('none');
  });

  test('scrubCredentials strips userinfo from quoted URLs in error text', () => {
    expect(scrubCredentials('connect failed for http://x:aoc_secret@debian:10255/foo')).toBe(
      'connect failed for http://***@debian:10255/foo',
    );
  });
});

describe('summarizeUpstreamError', () => {
  test('unwraps the gateway error envelope', () => {
    const body = JSON.stringify({
      error: { message: 'Free tier requests on this model are rate-limited.' },
    });
    expect(summarizeUpstreamError(body)).toBe('Free tier requests on this model are rate-limited.');
  });

  test('falls back to raw text when the body is not JSON', () => {
    expect(summarizeUpstreamError('upstream exploded')).toBe('upstream exploded');
  });

  test('scrubs credentials that leak into error bodies', () => {
    expect(summarizeUpstreamError('proxy //user:secret@host failed')).not.toContain('secret');
  });

  test('caps length so a stray HTML page cannot flood the chat', () => {
    expect(summarizeUpstreamError('x'.repeat(5000)).length).toBe(300);
  });
});

describe('startFxGatewayShim', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()?.();
    delete process.env.FX_UPSTREAM_GATEWAY_URL;
  });

  test('forwards requests to the upstream and streams the response back', async () => {
    const seen: Array<{ path: string; auth: string | null; body: string }> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get('authorization'),
          body: await req.text(),
        });
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      },
    });
    cleanup.push(() => upstream.stop(true));

    process.env.FX_UPSTREAM_GATEWAY_URL = `http://127.0.0.1:${upstream.port}`;
    const shim = startFxGatewayShim();
    cleanup.push(shim.stop);

    expect(shim.chatUrl).toBe(`${shim.baseUrl}${FX_CHAT_PATH}`);

    const models = await fetch(`${shim.baseUrl}/coding-agent/v1/models`, {
      headers: { authorization: 'Bearer placeholder' },
    });
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ ok: true });

    const chat = await fetch(shim.chatUrl, { method: 'POST', body: '{"prompt":"hi"}' });
    expect(chat.status).toBe(200);

    expect(seen[0]).toMatchObject({ path: '/coding-agent/v1/models', auth: 'Bearer placeholder' });
    expect(seen[1]).toMatchObject({ path: FX_CHAT_PATH, body: '{"prompt":"hi"}' });
  });

  test('returns 502 rather than hanging when the upstream is unreachable', async () => {
    process.env.FX_UPSTREAM_GATEWAY_URL = 'http://127.0.0.1:1';
    const shim = startFxGatewayShim();
    cleanup.push(shim.stop);

    const res = await fetch(`${shim.baseUrl}/coding-agent/v1/models`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('fx gateway shim');
  });

  // Regression for the bug that broke the real OneCLI path: a gzipped upstream
  // response must arrive intact rather than resetting the connection.
  test('relays a gzip-encoded upstream response without corrupting it', async () => {
    const payload = JSON.stringify({ data: ['a'.repeat(200)] });
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(Bun.gzipSync(Buffer.from(payload)), {
          headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
        }),
    });
    cleanup.push(() => upstream.stop(true));

    process.env.FX_UPSTREAM_GATEWAY_URL = `http://127.0.0.1:${upstream.port}`;
    const shim = startFxGatewayShim();
    cleanup.push(shim.stop);

    const res = await fetch(`${shim.baseUrl}/coding-agent/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(payload);
  });
});
