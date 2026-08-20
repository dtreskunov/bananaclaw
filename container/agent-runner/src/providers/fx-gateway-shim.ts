/**
 * Loopback shim that lets fx reach the AI gateway through OneCLI.
 *
 * OneCLI injects credentials by acting as an HTTPS proxy: a client sets
 * HTTPS_PROXY, and the proxy swaps a placeholder Authorization header for the
 * real vault credential. That only works for proxy-aware clients. The fx binary
 * reads no proxy or custom-CA environment variables at all (verified against
 * the released binary), so its requests would bypass OneCLI entirely and fail
 * to authenticate.
 *
 * fx does expose two knobs that accept arbitrary URLs:
 *   FX_GATEWAY_BASE_URL — model catalog and credits (/coding-agent/v1/*)
 *   FX_GATEWAY_CHAT_URL — inference (/v3/ai/language-model)
 * Both are required; pointing only the base URL at the shim still sends
 * inference to the real gateway.
 *
 * So we point both at a plain-HTTP server on loopback and re-issue each request
 * from Bun's fetch, which *is* proxy-aware. fx keeps sending its placeholder
 * key; OneCLI replaces it on the way out. No real credential is ever readable
 * from the fx process environment.
 */
const DEFAULT_UPSTREAM_BASE = 'https://ai-gateway.vercel.sh';

/** Read lazily so the upstream can be overridden per process (and in tests). */
function upstreamBase(): string {
  return process.env.FX_UPSTREAM_GATEWAY_URL || DEFAULT_UPSTREAM_BASE;
}

/** fx's default inference path, relative to the gateway base. */
export const FX_CHAT_PATH = '/v3/ai/language-model';

export interface FxUpstreamError {
  status: number;
  message: string;
  at: number;
}

export interface FxGatewayShim {
  /** Value for FX_GATEWAY_BASE_URL. */
  baseUrl: string;
  /** Value for FX_GATEWAY_CHAT_URL. */
  chatUrl: string;
  /**
   * Most recent non-2xx from the gateway. fx collapses every upstream failure
   * into stopReason 'refused' with no detail, so this is the only place the
   * real cause (rate limit, bad key, unknown model) is visible.
   */
  lastUpstreamError: () => FxUpstreamError | null;
  stop: () => void;
}

/** Hop-by-hop headers that must not be forwarded in either direction. */
const STRIPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

/**
 * fetch() transparently decompresses the upstream body, so relaying the
 * upstream's content-encoding would tell our client to inflate bytes that are
 * already plain. That mismatch shows up as a mid-response connection reset
 * rather than a decode error, so strip it on the way back out.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([...STRIPPED_HEADERS, 'content-encoding']);

export function forwardableHeaders(headers: Headers): Headers {
  return filterHeaders(headers, STRIPPED_HEADERS);
}

export function forwardableResponseHeaders(headers: Headers): Headers {
  return filterHeaders(headers, STRIPPED_RESPONSE_HEADERS);
}

function filterHeaders(headers: Headers, stripped: Set<string>): Headers {
  const out = new Headers();
  headers.forEach((value, key) => {
    if (!stripped.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

export function upstreamUrlFor(requestUrl: string, base_: string = upstreamBase()): string {
  const incoming = new URL(requestUrl);
  const base = new URL(base_);
  // Preserve any path prefix on the upstream base (e.g. a self-hosted gateway
  // mounted under a subpath) rather than clobbering it.
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  return `${base.origin}${prefix}${incoming.pathname}${incoming.search}`;
}

export function proxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || undefined
  );
}

/** Underlying fetch errors can quote the proxy URL, which carries the token. */
export function scrubCredentials(text: string): string {
  return text.replace(/\/\/[^/\s@]+:[^/\s@]+@/g, '//***@');
}

/** OneCLI embeds its gateway token as basic-auth userinfo — never log it. */
export function redactProxy(proxy: string | undefined): string {
  if (!proxy) return 'none';
  try {
    const u = new URL(proxy);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    return '<unparseable>';
  }
}

/** Gateway errors arrive as `{ error: { message } }`; fall back to raw text. */
export function summarizeUpstreamError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message;
    if (message) return scrubCredentials(message).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return scrubCredentials(body).slice(0, 300);
}

/**
 * Starts the shim on an ephemeral loopback port. Caller is responsible for
 * calling stop() when the session ends.
 */
export function startFxGatewayShim(): FxGatewayShim {
  const proxy = proxyUrl();
  let lastError: FxUpstreamError | null = null;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // fx streams inference responses; without a generous idle timeout Bun would
    // cut long turns off mid-stream.
    idleTimeout: 255,
    async fetch(req) {
      const target = upstreamUrlFor(req.url);
      const startedAt = Date.now();
      try {
        // Buffer the request body instead of relaying req.body as a stream.
        // Bun's proxied fetch cannot drive a half-duplex upload: with a
        // ReadableStream body it never flushes request headers upstream, so
        // every POST hangs until the client gives up while GETs (no body)
        // succeed. Inference payloads are tens of KB, so buffering is cheap,
        // and it lets fetch set an accurate content-length.
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
        const response = await fetch(target, {
          method: req.method,
          headers: forwardableHeaders(req.headers),
          ...(body && body.byteLength > 0 ? { body } : {}),
          ...(proxy ? { proxy } : {}),
        } as RequestInit);
        console.error(
          `[fx-gateway-shim] ${req.method} ${new URL(req.url).pathname} → ${response.status} ` +
            `(${body?.byteLength ?? 0}B in, ${Date.now() - startedAt}ms)`,
        );
        if (response.status >= 400) {
          // Error bodies are small and never usefully streamed, so buffer to
          // capture the reason and hand the client an identical response.
          const detail = await response.text();
          lastError = { status: response.status, message: summarizeUpstreamError(detail), at: Date.now() };
          return new Response(detail, {
            status: response.status,
            statusText: response.statusText,
            headers: forwardableResponseHeaders(response.headers),
          });
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: forwardableResponseHeaders(response.headers),
        });
      } catch (err) {
        const message = scrubCredentials(err instanceof Error ? err.message : String(err));
        console.error(
          `[fx-gateway-shim] ${req.method} ${target} failed after ${Date.now() - startedAt}ms: ${message}`,
        );
        return new Response(JSON.stringify({ error: { message: `fx gateway shim: ${message}` } }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  console.error(`[fx-gateway-shim] listening on ${baseUrl} → ${upstreamBase()} (proxy: ${redactProxy(proxy)})`);

  return {
    baseUrl,
    chatUrl: `${baseUrl}${FX_CHAT_PATH}`,
    lastUpstreamError: () => lastError,
    stop: () => server.stop(true),
  };
}
