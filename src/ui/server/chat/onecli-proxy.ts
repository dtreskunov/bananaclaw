/**
 * OneCLI proxy for outbound OpenRouter requests from the host process.
 *
 * The OneCLI gateway is an HTTPS CONNECT proxy that injects API credentials
 * (e.g. the OpenRouter API key) into requests passing through it. Containers
 * get the proxy wired automatically via env vars; the host uses this module
 * to route specific requests through the same gateway.
 *
 * The proxy config (URL + CA cert) is fetched once from the OneCLI control
 * plane and cached for the process lifetime.
 */
import http from 'http';
import https from 'https';
import tls from 'tls';
import fs from 'fs';
import { URL } from 'url';

import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../../../config.js';
import { log } from '../../../log.js';

interface ProxyConfig {
  proxyUrl: URL;
  caCert: string;
}

const DEFAULT_AGENT_KEY = '__default__';
const cachedConfigs = new Map<string, ProxyConfig>();
const configPromises = new Map<string, Promise<ProxyConfig | null>>();

async function resolveProxyConfig(agent?: string): Promise<ProxyConfig | null> {
  const key = agent ?? DEFAULT_AGENT_KEY;
  const cached = cachedConfigs.get(key);
  if (cached) return cached;
  const inflight = configPromises.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    if (!ONECLI_URL || !ONECLI_API_KEY) {
      log.debug('OneCLI not configured — proxy unavailable');
      return null;
    }
    try {
      const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
      const config = await onecli.getContainerConfig({ agent });
      const rawProxy = config.env.HTTPS_PROXY || config.env.https_proxy;
      if (!rawProxy) {
        log.warn('OneCLI config has no HTTPS_PROXY', { agent: agent ?? null });
        return null;
      }
      // Replace host.docker.internal with the actual OneCLI host (for host-side use)
      const onecliHost = new URL(ONECLI_URL).hostname;
      const hostProxy = rawProxy.replace('host.docker.internal', onecliHost);

      const resolved: ProxyConfig = { proxyUrl: new URL(hostProxy), caCert: config.caCertificate };
      cachedConfigs.set(key, resolved);
      log.info('OneCLI proxy configured', {
        agent: agent ?? null,
        proxy: `${resolved.proxyUrl.hostname}:${resolved.proxyUrl.port}`,
      });
      return resolved;
    } catch (err) {
      log.warn('Failed to resolve OneCLI proxy config', { agent: agent ?? null, err: String(err) });
      return null;
    } finally {
      configPromises.delete(key);
    }
  })();
  configPromises.set(key, p);
  return p;
}

/**
 * Fetch a URL through the OneCLI CONNECT proxy.
 * Falls back to a direct fetch (with explicit API key) if the proxy is unavailable.
 *
 * If `agent` is provided, credentials are scoped to that OneCLI agent
 * (matching the per-agent vault assignment). Without `agent`, the host's
 * default agent is used.
 */
export async function proxyFetch(
  url: string,
  init: RequestInit & { timeout?: number; agent?: string },
): Promise<Response> {
  const { agent, ...rest } = init;
  const config = await resolveProxyConfig(agent);
  if (!config) {
    // Fallback: direct fetch (caller must handle auth separately)
    return fetch(url, rest);
  }
  return tunnelFetch(url, rest, config);
}

/**
 * Returns true if the OneCLI proxy is available (configured and reachable)
 * for the given agent (or the default agent if omitted).
 */
export async function isProxyAvailable(agent?: string): Promise<boolean> {
  const config = await resolveProxyConfig(agent);
  return config !== null;
}

/**
 * Ensure the OneCLI agent record exists. Safe to call repeatedly — OneCLI
 * `ensureAgent` is idempotent. Returns true on success, false if OneCLI is
 * not configured or the call fails (caller can still fall back to the
 * default-agent proxy).
 */
const ensuredAgents = new Set<string>();
export async function ensureOneCliAgent(name: string, identifier: string): Promise<boolean> {
  if (!ONECLI_URL || !ONECLI_API_KEY) return false;
  if (ensuredAgents.has(identifier)) return true;
  try {
    const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
    await onecli.ensureAgent({ name, identifier });
    ensuredAgents.add(identifier);
    return true;
  } catch (err) {
    log.warn('OneCLI ensureAgent failed', { identifier, err: String(err) });
    return false;
  }
}

function tunnelFetch(
  targetUrl: string,
  init: RequestInit & { timeout?: number },
  config: ProxyConfig,
): Promise<Response> {
  const target = new URL(targetUrl);
  const { proxyUrl, caCert } = config;
  const timeoutMs = init.timeout ?? 30_000;

  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      hostname: proxyUrl.hostname,
      port: parseInt(proxyUrl.port, 10),
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: {
        'Proxy-Authorization':
          'Basic ' +
          Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString(
            'base64',
          ),
        Host: `${target.hostname}:${target.port || 443}`,
      },
      timeout: timeoutMs,
    });

    connectReq.on('connect', (_res, socket) => {
      // Upgrade to TLS over the tunnel
      const tlsSocket = tls.connect(
        {
          socket,
          servername: target.hostname,
          ca: caCert,
        },
        () => {
          // Now make the HTTPS request through the TLS tunnel
          const reqOptions: https.RequestOptions = {
            hostname: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: init.method || 'GET',
            headers: {
              ...((init.headers as Record<string, string>) || {}),
              Host: target.hostname,
            },
            createConnection: () => tlsSocket,
            timeout: timeoutMs,
          };

          const httpsReq = https.request(reqOptions, (res) => {
            // Convert Node IncomingMessage to a Web Response
            const headers = new Headers();
            for (const [key, val] of Object.entries(res.headers)) {
              if (val) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
            }

            // Create a ReadableStream from the response
            const readable = new ReadableStream({
              start(controller) {
                res.on('data', (chunk: Buffer) => controller.enqueue(chunk));
                res.on('end', () => controller.close());
                res.on('error', (err) => controller.error(err));
              },
            });

            resolve(
              new Response(readable, {
                status: res.statusCode || 500,
                statusText: res.statusMessage || '',
                headers,
              }),
            );
          });

          httpsReq.on('error', (err) => reject(err));
          httpsReq.on('timeout', () => {
            httpsReq.destroy();
            reject(new Error('request_timeout'));
          });

          if (init.body) {
            httpsReq.write(typeof init.body === 'string' ? init.body : init.body);
          }
          httpsReq.end();
        },
      );

      tlsSocket.on('error', (err) => reject(err));
    });

    connectReq.on('error', (err) => reject(err));
    connectReq.on('timeout', () => {
      connectReq.destroy();
      reject(new Error('connect_timeout'));
    });
    connectReq.end();
  });
}
