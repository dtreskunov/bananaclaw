import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { GROUPS_DIR, PAGES_BASE_DOMAIN } from '../../../config.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { log } from '../../../log.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { registerHostHandler } from '../../../webhook-server.js';
import { readCookie, recordAccess } from '../auth.js';
import { inspectPrivateWebHandoff, lookupPrivateWebSession, redeemPrivateWebHandoff } from '../private-web-db.js';
import { resolvePrivateWebEntry } from '../private-web-path.js';
import { isUiEnabled, uiBaseUrl } from '../server.js';
import { classify } from '../chat/classify.js';
import { pagesEnabled } from './site.js';
import { serveWebRoot } from './web-root.js';

const COOKIE_NAME = 'private_web_session';
const ID_RE = /^[a-f0-9]{48}$/;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_WRITE_BYTES = 10 * 1024 * 1024;
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 60_000;
const PREVIEW_SHELL_PATH = path.resolve(process.cwd(), 'src', 'ui', 'server', 'pages', 'private-web-shell.html');
const writeWindows = new Map<string, number[]>();

function hostId(hostHeader: string | undefined): { owned: boolean; id: string | null } {
  if (!pagesEnabled() || !hostHeader) return { owned: false, id: null };
  const host = hostHeader.split(':')[0].trim().toLowerCase();
  const suffix = `.${PAGES_BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return { owned: false, id: null };
  const label = host.slice(0, -suffix.length);
  if (!label.startsWith('secure-')) return { owned: false, id: null };
  if (label.includes('.')) return { owned: true, id: null };
  const id = label.slice('secure-'.length);
  return { owned: true, id: ID_RE.test(id) ? id : null };
}

function text(res: http.ServerResponse, status: number, body: string, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'private, no-store',
    ...headers,
  });
  res.end(body);
}

function isDocumentNavigation(req: http.IncomingMessage): boolean {
  const destination = req.headers['sec-fetch-dest'];
  if (destination === 'document' || destination === 'iframe') return true;
  return String(req.headers.accept || '')
    .toLowerCase()
    .includes('text/html');
}

function expired(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!isDocumentNavigation(req)) {
    text(res, 401, 'Private web session expired.');
    return;
  }
  const parentOrigin = new URL(uiBaseUrl()).origin;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session expired</title></head><body><p>Private web session expired.</p><script>if(parent!==window)parent.postMessage({type:'nanoclaw-private-web-expired'},parent===top?${JSON.stringify(parentOrigin)}:location.origin)</script></body></html>`;
  res.writeHead(401, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors ${parentOrigin}`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function normalizeNext(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  const segments = raw.slice(1).split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\0') || segment.includes('\\'),
    )
  )
    return null;
  return segments.join('/');
}

function memberVisible(relativePath: string): boolean {
  const classification = classify(relativePath);
  return classification.kind === 'visible' && classification.tier === 'member';
}

function privateCsp(): string {
  const frameAncestor = new URL(uiBaseUrl()).origin;
  return [
    'sandbox allow-scripts allow-same-origin',
    "default-src 'none'",
    // 'wasm-unsafe-eval' permits WebAssembly compilation without permitting JS
    // eval()/new Function(). Applications are first-party workspace files on a
    // disposable per-session origin, and script-src already allows inline
    // script, so this grants no authority an app does not already have.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors 'self' ${frameAncestor}`,
  ].join('; ');
}

function previewShell(relativePath: string): string {
  const src = `/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
  const parentOrigin = new URL(uiBaseUrl()).origin;
  return fs
    .readFileSync(PREVIEW_SHELL_PATH, 'utf8')
    .replace('"{{PREVIEW_SRC}}"', JSON.stringify(src))
    .replace('"{{PARENT_ORIGIN}}"', JSON.stringify(parentOrigin));
}

function servePreviewShell(res: http.ServerResponse, relativePath: string, headOnly: boolean): void {
  const body = previewShell(relativePath);
  const parentOrigin = new URL(uiBaseUrl()).origin;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors ${parentOrigin}`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(headOnly ? undefined : body);
}

function allowWrite(principal: string): boolean {
  const now = Date.now();
  const current = (writeWindows.get(principal) || []).filter((at) => at > now - WRITE_WINDOW_MS);
  if (current.length >= WRITE_LIMIT) {
    writeWindows.set(principal, current);
    return false;
  }
  current.push(now);
  writeWindows.set(principal, current);
  return true;
}

async function redeem(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): Promise<void> {
  const token = url.searchParams.get('t');
  const next = normalizeNext(url.searchParams.get('next'));
  if (!token || !next) return text(res, 400, 'Invalid handoff.');
  const inspected = inspectPrivateWebHandoff(id, token);
  if (!inspected) return text(res, 401, 'Expired or invalid handoff.');
  const group = getAgentGroup(inspected.agentGroupId);
  if (!group || !canAccessAgentGroup(inspected.userId, group.id).allowed || !resolvePrivateWebEntry(group, next)) {
    return text(res, 404, 'Not found.');
  }
  const redeemed = redeemPrivateWebHandoff(id, token);
  if (!redeemed) return text(res, 401, 'Expired or already used handoff.');
  const entryLocation = `/${next.split('/').map(encodeURIComponent).join('/')}`;
  const location =
    url.searchParams.get('preview') === '1' ? `/_preview?path=${encodeURIComponent(entryLocation)}` : entryLocation;
  res.writeHead(303, {
    Location: location,
    'Set-Cookie': `${COOKIE_NAME}=${redeemed.secureToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end();
}

export async function handlePrivateWebRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const match = hostId(req.headers.host);
  if (!match.owned) return false;
  if (!match.id) {
    text(res, 404, 'Not found.');
    return true;
  }
  const url = new URL(req.url || '/', `https://${req.headers.host}`);
  if (url.pathname === '/_auth/redeem') {
    if (req.method !== 'GET') text(res, 405, 'Method not allowed.', { Allow: 'GET' });
    else await redeem(req, res, match.id, url);
    return true;
  }
  if (url.pathname === '/_auth' || url.pathname.startsWith('/_auth/')) {
    text(res, 404, 'Not found.');
    return true;
  }
  const token = readCookie(req, COOKIE_NAME);
  const session = token ? lookupPrivateWebSession(match.id, token) : null;
  if (!session) {
    expired(req, res);
    return true;
  }
  const group = getAgentGroup(session.agentGroupId);
  if (!group || !canAccessAgentGroup(session.userId, group.id).allowed) {
    text(res, 404, 'Not found.');
    return true;
  }
  if (url.pathname === '/_preview') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      text(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
      return true;
    }
    const next = normalizeNext(url.searchParams.get('path'));
    if (!next || !memberVisible(next) || !resolvePrivateWebEntry(group, next)) {
      text(res, 404, 'Not found.');
      return true;
    }
    servePreviewShell(res, next, req.method === 'HEAD');
    return true;
  }
  if (req.method === 'PUT' && !allowWrite(`${session.userId}:${session.agentGroupId}`)) {
    text(res, 429, 'Too many writes.', { 'Retry-After': '60' });
    return true;
  }
  await serveWebRoot(req, res, {
    filesystemRoot: path.resolve(GROUPS_DIR, group.folder),
    cacheControl: 'private, no-store',
    maxFileBytes: MAX_FILE_BYTES,
    maxWriteBytes: MAX_WRITE_BYTES,
    capabilities: new Set(['read', 'replace']),
    canRead: memberVisible,
    headers: (absolutePath) => ({
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      ...(absolutePath.toLowerCase().match(/\.html?$/) ? { 'Content-Security-Policy': privateCsp() } : {}),
    }),
    onRead: (relativePath) => {
      recordAccess({ userId: session.userId, groupId: group.id, path: relativePath, action: 'private_web_read', req });
    },
    onReplace: ({ relativePath, oldContent, newContent }) => {
      recordAccess({ userId: session.userId, groupId: group.id, path: relativePath, action: 'private_web_write', req });
      log.info('Private web file replaced', {
        userId: session.userId,
        groupId: group.id,
        path: relativePath,
        oldHash: crypto.createHash('sha256').update(oldContent).digest('hex'),
        newHash: crypto.createHash('sha256').update(newContent).digest('hex'),
      });
    },
  });
  return true;
}

let registered = false;

export function registerPrivateWebHostHandler(): void {
  if (registered || !isUiEnabled() || !pagesEnabled()) return;
  registerHostHandler(handlePrivateWebRequest);
  registered = true;
  log.info('Private web host handler registered');
}
