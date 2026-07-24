/**
 * UI shell. Hosts shared authentication for everything mounted under
 * {@link UI_MOUNT_PREFIX} (`/ui`) on the shared HTTP server (see
 * ../../webhook-server.ts). Individual UI apps (currently just the chat
 * browser at `/ui/chat`) reuse the cookie minted here — no per-app login.
 *
 * Env:
 *   UI_ENABLED   — 'true' to mount the UI (shared auth + every registered app)
 *   UI_SECURE    — 'true' to mark session cookies Secure (set when fronted
 *                  by HTTPS)
 *   UI_BASE_URL  — explicit external base URL used when minting magic-link
 *                  URLs. Defaults to http://localhost:${WEBHOOK_PORT}/ui.
 */
import http from 'http';
import path from 'path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { ensureSharedHttpServer, mountHandler, mountUpgradeHandler } from '../../webhook-server.js';
import {
  authenticate,
  buildClearCookie,
  buildSessionCookie,
  logout as authLogout,
  recordAccess,
  redeemAndCreateSession,
} from './auth.js';
import { purgeExpired } from './db.js';
import { purgeExpiredPrivateWebSessions } from './private-web-db.js';
import { resolvePrivateWebEntry } from './private-web-path.js';
import { handleLandingPage, ASSETS_MOUNT_PREFIX } from './landing-page.js';
import { handleOidcRoute, renderLoginPage } from './oidc-routes.js';
import { handleOnboarding } from './onboarding.js';
import { handleSettings } from './settings.js';
import { handle as chatHandle, CHAT_MOUNT_PREFIX, handleChatUpgrade } from './chat/routes.js';

/** Path prefix every UI app lives under. Shared cookie path. */
export const UI_MOUNT_PREFIX = '/ui';
/** Where a successful magic-link redeem redirects when no `next` is given. */
const DEFAULT_LANDING = `${UI_MOUNT_PREFIX}/chat/`;

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

let purgeTimer: NodeJS.Timeout | null = null;
let mounted = false;

function readConfig(): { enabled: boolean; secure: boolean } {
  const env = readEnvFile(['UI_ENABLED', 'UI_SECURE']);
  const enabled = (process.env.UI_ENABLED || env.UI_ENABLED) === 'true';
  const secure = (process.env.UI_SECURE || env.UI_SECURE) === 'true';
  return { enabled, secure };
}

/** Whether the UI shell is enabled and mounted (set via UI_ENABLED). */
export function isUiEnabled(): boolean {
  return readConfig().enabled;
}

export function startUi(): void {
  const cfg = readConfig();
  if (!cfg.enabled) {
    log.info('UI disabled (set UI_ENABLED=true to mount)');
    return;
  }
  if (mounted) return;

  ensureSharedHttpServer();

  const withAccessLog =
    (app: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) =>
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      const start = Date.now();
      handler(req, res)
        .catch((err) => {
          log.error(`UI ${app} dispatch threw`, { err });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        })
        .finally(() => {
          log.info('UI request', {
            app,
            method: req.method,
            url: req.url,
            status: res.statusCode,
            ms: Date.now() - start,
          });
        });
    };

  // Shared auth endpoints (cookie applies to all of /ui).
  mountHandler(
    `${UI_MOUNT_PREFIX}/auth`,
    withAccessLog('auth', (req, res) => handleAuth(req, res, cfg.secure)),
  );

  // Stand-alone login page (served outside the chat app so the 401
  // redirect target is independent of any app's bundle).
  mountHandler(
    `${UI_MOUNT_PREFIX}/login`,
    withAccessLog('login', async (req, res) => {
      const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLoginPage(u.searchParams.get('next')));
    }),
  );

  // Per-app mounts. Add more here as new UI apps are introduced.
  mountHandler(`${UI_MOUNT_PREFIX}/view`, withAccessLog('private-web-view', handlePrivateWebView));
  mountHandler(CHAT_MOUNT_PREFIX, withAccessLog('chat', chatHandle));
  mountUpgradeHandler(CHAT_MOUNT_PREFIX, handleChatUpgrade);

  // Settings (identity linking, etc.) — server-rendered, no SPA.
  mountHandler(`${UI_MOUNT_PREFIX}/settings`, withAccessLog('settings', handleSettings));

  // First-login onboarding wizard (splash + display name / agent naming).
  // Server-rendered, mounted outside the chat SPA so completeLogin can
  // redirect here before the user ever loads the chat bundle.
  mountHandler(
    `${UI_MOUNT_PREFIX}/onboarding`,
    withAccessLog('onboarding', (req, res) => handleOnboarding(req, res)),
  );

  // Public landing page at the apex '/' (exact-root match only) plus its
  // imagery under '/assets/*'. The page links to /ui/chat for login, which
  // redirects to the auth flow when the visitor isn't signed in.
  mountHandler('/', withAccessLog('landing', handleLandingPage));
  mountHandler(ASSETS_MOUNT_PREFIX, withAccessLog('landing-assets', handleLandingPage));

  mounted = true;
  log.info('UI mounted', { prefix: UI_MOUNT_PREFIX, apps: [CHAT_MOUNT_PREFIX], secure: cfg.secure });

  purgeTimer = setInterval(() => {
    try {
      purgeExpired();
      purgeExpiredPrivateWebSessions();
    } catch (err) {
      log.warn('UI purge failed', { err });
    }
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();
}

function decodeViewPath(pathname: string): { groupId: string; relativePath: string } | null {
  const prefix = `${UI_MOUNT_PREFIX}/view/`;
  if (!pathname.startsWith(prefix)) return null;
  const rawSegments = pathname.slice(prefix.length).split('/');
  if (rawSegments.length < 2) return null;
  try {
    const segments = rawSegments.map((segment) => decodeURIComponent(segment));
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          segment.includes('\0') ||
          segment.includes('/') ||
          segment.includes('\\'),
      )
    ) {
      return null;
    }
    return { groupId: segments[0]!, relativePath: segments.slice(1).join('/') };
  } catch {
    return null;
  }
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handlePrivateWebView(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const target = decodeViewPath(parsedUrl.pathname);
  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const session = authenticate(req);
  if (!session) {
    const next = req.url || parsedUrl.pathname;
    res.writeHead(303, { Location: `/ui/login?next=${encodeURIComponent(next)}` });
    res.end();
    return;
  }
  if (!canAccessAgentGroup(session.userId, target.groupId).allowed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const group = getAgentGroup(target.groupId);
  if (!group || !resolvePrivateWebEntry(group, target.relativePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${htmlAttribute(path.basename(target.relativePath))}</title><link rel="stylesheet" href="/ui/chat/dist/private-web.css"></head><body class="private-web-page"><div id="private-web-root" data-group-id="${htmlAttribute(target.groupId)}" data-path="${htmlAttribute(target.relativePath)}"></div><script type="module" src="/ui/chat/dist/private-web.js"></script></body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

export async function stopUi(): Promise<void> {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
  // Shared server lifecycle is owned by stopWebhookServer; nothing to do here.
}

/** Compute the external base URL used for magic-link URLs (ends in /ui, no trailing slash). */
export function uiBaseUrl(): string {
  const env = readEnvFile(['UI_BASE_URL', 'WEBHOOK_PORT']);
  const explicit = process.env.UI_BASE_URL || env.UI_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const port = process.env.WEBHOOK_PORT || env.WEBHOOK_PORT || '3000';
  return `http://localhost:${port}${UI_MOUNT_PREFIX}`;
}

// ── auth dispatcher ───────────────────────────────────────────────────────

async function handleAuth(req: http.IncomingMessage, res: http.ServerResponse, secureCookie: boolean): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  const prefix = `${UI_MOUNT_PREFIX}/auth`;
  if (pathname.startsWith(prefix)) pathname = pathname.slice(prefix.length) || '/';

  if (req.method === 'GET' && pathname === '/redeem') return handleRedeem(req, res, url, secureCookie);
  if (req.method === 'POST' && pathname === '/logout') return handleLogout(req, res, secureCookie);
  if (pathname.startsWith('/oidc/')) return handleOidcRoute(req, res, pathname, url, secureCookie);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

function handleRedeem(req: http.IncomingMessage, res: http.ServerResponse, url: URL, secureCookie: boolean): void {
  const token = url.searchParams.get('t');
  if (!token) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing token');
    return;
  }
  const result = redeemAndCreateSession(token);
  if (!result) {
    recordAccess({ userId: null, groupId: null, path: null, action: 'auth.redeem_failed', req });
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid or expired link');
    return;
  }
  recordAccess({ userId: result.userId, groupId: null, path: null, action: 'auth.login', req });
  const next = sanitizeNext(url.searchParams.get('next')) || DEFAULT_LANDING;
  res.writeHead(303, {
    Location: next,
    'Set-Cookie': buildSessionCookie(result.token, secureCookie),
  });
  res.end();
}

function handleLogout(req: http.IncomingMessage, res: http.ServerResponse, secureCookie: boolean): void {
  authLogout(req);
  recordAccess({ userId: null, groupId: null, path: null, action: 'auth.logout', req });
  res.writeHead(303, { Location: DEFAULT_LANDING, 'Set-Cookie': buildClearCookie(secureCookie) });
  res.end();
}

function sanitizeNext(next: string | null): string | null {
  if (!next) return null;
  // Only allow same-origin redirects under /ui to avoid open-redirect.
  if (!next.startsWith(`${UI_MOUNT_PREFIX}/`)) return null;
  return next;
}
