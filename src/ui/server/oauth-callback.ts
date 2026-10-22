/**
 * Public OAuth endpoints for the credential gateway (fork change F11).
 *
 * - `GET /ui/oauth/callback`: the provider redirects the sign-in popup here.
 *   It completes only for the signed-in NanoClaw user who started the
 *   sign-in, forwards `state`, `code` and `iss` (or the provider's `error`) to
 *   the private gateway, then tells the opening settings tab via postMessage.
 *   It lives under /ui so the session cookie (Path=/ui) is sent.
 * - `GET /oauth/client-metadata.json`: the gateway's client metadata document
 *   (CIMD), published at the origin as its client ID requires.
 *
 * The PKCE verifier and any client secret stay in the gateway, so the host
 * can relay the code but never redeem it.
 */
import { randomBytes } from 'crypto';
import http from 'http';

import { log } from '../../log.js';
import { AgentVaultError, gatewayMessage } from '../../modules/credentials/agent-vault-client.js';
import { clientMetadata, completeOAuth, forgetProbes } from '../../modules/credentials/gateway-credentials.js';
import { finishSignIn, getSignIn } from '../../modules/credentials/sign-ins.js';
import { authenticate, recordAccess } from './auth.js';

export const OAUTH_CALLBACK_PATH = '/ui/oauth/callback';
export const CLIENT_METADATA_PATH = '/oauth/client-metadata.json';
const METADATA_CACHE_MS = 5 * 60_000;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Small page that reports the result and notifies the same-origin opener, then closes. */
function renderResult(
  res: http.ServerResponse,
  status: number,
  result: { state?: string; ok: boolean; title: string; detail: string },
): void {
  const nonce = randomBytes(16).toString('base64');
  const message = result.state
    ? JSON.stringify({
        type: 'nanoclaw-oauth-complete',
        state: result.state,
        status: result.ok ? 'connected' : 'failed',
      })
    : 'null';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(result.title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}p{color:#555}</style></head><body><h1>${escapeHtml(result.title)}</h1><p>${escapeHtml(result.detail)}</p><p><a href="/ui/chat/">Back to NanoClaw</a></p><script nonce="${nonce}">(function(){history.replaceState(null,'',location.pathname);var m=${message.replace(/</g, '\\u003c')};if(m&&window.opener&&!window.opener.closed){try{window.opener.postMessage(m,location.origin)}catch(e){}${result.ok ? 'setTimeout(function(){window.close()},600)' : ''}}})();</script></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The URL carried an authorization code; never leak it in a Referer.
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  res.end(body);
}

export async function handleOAuthCallback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== OAUTH_CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? undefined;
  const iss = url.searchParams.get('iss') ?? undefined;
  const error = url.searchParams.get('error') ?? undefined;

  const session = authenticate(req);
  if (!session) {
    // Sign in, then come back here; the provider's code is still valid for a few minutes.
    res.writeHead(303, {
      Location: `/ui/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
    return;
  }
  const signIn = state ? getSignIn(state) : undefined;
  if (!signIn || signIn.userId !== session.userId) {
    recordAccess({
      userId: session.userId,
      groupId: signIn?.agentGroupId ?? null,
      path: null,
      action: 'oauth.callback_rejected',
      req,
    });
    renderResult(res, 400, {
      ok: false,
      title: 'Sign-in not completed',
      detail:
        'This sign-in has expired or was started by someone else. Start it again from Agent Settings → Credentials.',
    });
    return;
  }
  if (signIn.status !== 'pending') {
    renderResult(res, 200, {
      state,
      ok: signIn.status === 'connected',
      title: signIn.status === 'connected' ? 'Signed in' : 'Sign-in failed',
      detail:
        signIn.status === 'connected' ? 'You can close this window.' : (signIn.error ?? 'Start the sign-in again.'),
    });
    return;
  }
  if (!code && !error) {
    renderResult(res, 400, {
      state,
      ok: false,
      title: 'Sign-in failed',
      detail: 'The provider returned no authorization code.',
    });
    return;
  }

  try {
    const result = await completeOAuth({ state, code, iss, error });
    const ok = result.status === 'connected';
    const detail = ok
      ? `${signIn.label} is connected. You can close this window.`
      : error === 'access_denied'
        ? 'You declined access at the provider.'
        : (result.error ?? 'The provider did not accept the sign-in.');
    finishSignIn(state, {
      status: ok ? 'connected' : 'failed',
      account: result.account ?? null,
      error: ok ? undefined : detail,
    });
    forgetProbes(signIn.agentGroupId);
    recordAccess({
      userId: session.userId,
      groupId: signIn.agentGroupId,
      path: null,
      action: ok ? 'oauth.connected' : 'oauth.failed',
      req,
    });
    renderResult(res, 200, { state, ok, title: ok ? 'Signed in' : 'Sign-in failed', detail });
  } catch (err) {
    if (!(err instanceof AgentVaultError)) throw err;
    const detail = err.unreachable
      ? "The credential gateway isn't responding. Try again in a moment."
      : err.code === 'issuer_mismatch'
        ? "The provider's response didn't match the server you started signing in to."
        : gatewayMessage(err);
    log.warn('OAuth completion failed', {
      gid: signIn.agentGroupId,
      code: err.code,
      status: err.status,
      err: err.message,
    });
    finishSignIn(state, { status: 'failed', error: detail });
    renderResult(res, err.unreachable ? 503 : 400, { state, ok: false, title: 'Sign-in failed', detail });
  }
}

let metadataCache: { at: number; body: string } | null = null;

export async function handleClientMetadata(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== CLIENT_METADATA_PATH || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const now = Date.now();
  if (!metadataCache || now - metadataCache.at > METADATA_CACHE_MS) {
    try {
      metadataCache = { at: now, body: JSON.stringify(await clientMetadata()) };
    } catch (err) {
      if (!(err instanceof AgentVaultError)) throw err;
      log.warn('Client metadata unavailable from the credential gateway', { err: err.message });
      if (!metadataCache) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'unavailable' }));
        return;
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : metadataCache.body);
}

/** Test seam. */
export function resetClientMetadataCache(): void {
  metadataCache = null;
}
