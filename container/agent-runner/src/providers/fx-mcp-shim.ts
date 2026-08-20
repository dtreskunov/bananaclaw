/**
 * Loopback shims that let fx reach remote MCP servers through OneCLI.
 *
 * Same problem as the gateway shim: OneCLI injects credentials by acting as an
 * HTTPS proxy, and the fx binary reads no proxy or custom-CA environment
 * variables at all. An `http`/`sse` MCP server therefore goes straight to the
 * vendor without the vault's Authorization header, and fx reports the 401 as
 * "Authentication required; supply an Authorization header in the ACP MCP
 * server configuration" — which is misleading here, since supplying the header
 * would mean putting a raw credential in the container.
 *
 * So each remote MCP server gets its own loopback listener that re-issues
 * requests through Bun's proxy-aware fetch. fx's endpoint policy accepts
 * explicit loopback HTTP (see streamable_http.validateEndpoint), so it will
 * talk to them.
 *
 * One listener *per server* rather than one multiplexed listener with a path
 * prefix: the SSE transport makes the server hand back a message endpoint that
 * fx resolves against the discovery URL and rejects unless it is same-origin.
 * A shared listener would drop the prefix during that resolution and misroute;
 * a dedicated port makes the origin carry the routing.
 */
import { forwardableHeaders, forwardableResponseHeaders, proxyUrl, scrubCredentials } from './fx-gateway-shim.js';
import type { McpServerConfig } from './types.js';

export interface FxMcpShims {
  /** Loopback URL to advertise to fx, or undefined when the server isn't shimmed. */
  urlFor: (name: string) => string | undefined;
  stop: () => void;
}

/** Remote transports need the shim; stdio servers already run in-container. */
function isRemote(config: McpServerConfig): config is McpServerConfig & { url: string } {
  return 'url' in config && typeof config.url === 'string' && config.url.length > 0;
}

/**
 * The JSON-RPC method a failed request was carrying, for the error log.
 * fx's dialects differ in which method they open with, so this identifies the
 * handshake stage that the server rejected.
 */
export function jsonRpcMethod(body: ArrayBuffer | undefined): string {
  if (!body || body.byteLength === 0) return 'no body';
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { method?: unknown };
    return typeof parsed.method === 'string' ? parsed.method : 'no method';
  } catch {
    return 'unparseable body';
  }
}

/**
 * Re-issues one request at `origin`, keeping the path, query, method and body.
 * Split out from the listener so it can be exercised without a remote host.
 */
export async function forwardToUpstream(
  name: string,
  origin: string,
  req: Request,
  proxy: string | undefined,
): Promise<Response> {
  const incoming = new URL(req.url);
  const target = `${origin}${incoming.pathname}${incoming.search}`;
  try {
    // Buffered rather than streamed for the same reason as the gateway shim:
    // Bun's proxied fetch never flushes headers for a streaming request body,
    // so every POST would hang.
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const response = await fetch(target, {
      method: req.method,
      headers: forwardableHeaders(req.headers),
      ...(body && body.byteLength > 0 ? { body } : {}),
      ...(proxy ? { proxy } : {}),
    } as RequestInit);
    if (response.status >= 400) {
      // fx reduces any MCP startup failure to a one-line ACP error that names
      // neither the request nor the server's reason, so log both here — this is
      // the only place the actual exchange is visible.
      const detail = await response.text();
      console.error(
        `[fx-mcp-shim] ${name} ${req.method} ${incoming.pathname} → ${response.status} ` +
          `(${jsonRpcMethod(body)}): ${scrubCredentials(detail).slice(0, 300)}`,
      );
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
    console.error(`[fx-mcp-shim] ${name} ${req.method} ${target} failed: ${message}`);
    return new Response(JSON.stringify({ error: { message: `fx mcp shim: ${message}` } }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

function startOne(name: string, upstream: URL, proxy: string | undefined): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // MCP streams tool results over SSE and holds a GET open for server
    // notifications, so the idle timeout has to be generous.
    idleTimeout: 255,
    fetch: (req) => forwardToUpstream(name, upstream.origin, req, proxy),
  });

  // Keep the upstream's path so fx addresses the same endpoint it would have
  // reached directly; the origin is all that changes.
  const path = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/$/, '');
  return { url: `http://127.0.0.1:${server.port}${path}`, stop: () => server.stop(true) };
}

export function startFxMcpShims(servers: Record<string, McpServerConfig> | undefined): FxMcpShims {
  const proxy = proxyUrl();
  const urls = new Map<string, string>();
  const stops: Array<() => void> = [];

  for (const [name, config] of Object.entries(servers ?? {})) {
    if (!isRemote(config)) continue;
    let upstream: URL;
    try {
      upstream = new URL(config.url);
    } catch {
      console.error(`[fx-mcp-shim] ${name}: unparseable url, passing through unshimmed`);
      continue;
    }
    // Already loopback: the target is in-container, so there is nothing for
    // OneCLI to inject and an extra hop would only add failure modes.
    if (upstream.hostname === '127.0.0.1' || upstream.hostname === 'localhost' || upstream.hostname === '[::1]') {
      continue;
    }
    const started = startOne(name, upstream, proxy);
    urls.set(name, started.url);
    stops.push(started.stop);
    console.error(`[fx-mcp-shim] ${name}: ${started.url} → ${upstream.origin}`);
  }

  return {
    urlFor: (name) => urls.get(name),
    stop: () => {
      for (const stop of stops) stop();
      stops.length = 0;
      urls.clear();
    },
  };
}
