/**
 * Cookie + magic-link authentication shared across all UI apps mounted
 * under /ui.
 *
 * Bearer-token model with server-side session table — no signed cookies, no
 * shared HMAC key. The token in the cookie / URL is opaque; the DB stores
 * only sha256(token).
 */
import http from 'http';

import { log } from '../../log.js';
import { insertIdentity, getIdentity } from '../../modules/permissions/db/identities.js';
import { createMagicLink, createSession, deleteSession, lookupSession, logAccess, redeemMagicLink } from './db.js';

// Cookie scope. Kept in sync with UI_MOUNT_PREFIX in server.ts; inlined to
// avoid a server.ts ↔ auth.ts ESM TDZ cycle.
export const COOKIE_PATH = '/ui';

export const COOKIE_NAME = 'ui_session';
export const MAGIC_LINK_TTL_MS = 10 * 60 * 1000; // 10 min
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function issueMagicLink(userId: string): { token: string; expiresAt: string } {
  const out = createMagicLink(userId, MAGIC_LINK_TTL_MS);
  log.info('UI magic link issued', { userId, expiresAt: out.expiresAt });
  return out;
}

/** Create a session for a user that was already authenticated upstream
 * (OIDC callback, admin impersonation, etc.). Magic-link redeem uses
 * the wrapper below; both paths funnel through `createSession`.
 *
 * Also seeds the web identity (channel='web', handle=<user uuid>) if
 * missing — every entry point that mints a UI session must guarantee it,
 * otherwise the inbound web message handler later mints a phantom user
 * via `getOrCreateUserByIdentity`. Idempotent. */
export function createUiSessionForUser(userId: string): { token: string; expiresAt: string } {
  if (!getIdentity('web', userId)) {
    insertIdentity({ userId, channel: 'web', handle: userId, primary: true });
  }
  const session = createSession(userId, SESSION_TTL_MS);
  log.info('UI session created', { userId, expiresAt: session.expiresAt });
  return session;
}

/** Returns user_id on success; null on invalid/expired/already-redeemed. */
export function redeemAndCreateSession(token: string): { token: string; userId: string; expiresAt: string } | null {
  const userId = redeemMagicLink(token);
  if (!userId) return null;
  return { ...createUiSessionForUser(userId), userId };
}

export function authenticate(req: http.IncomingMessage): { userId: string; sessionHash: string } | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const session = lookupSession(token);
  if (!session) return null;
  return { userId: session.userId, sessionHash: session.tokenHash };
}

export function logout(req: http.IncomingMessage): void {
  const token = readCookie(req, COOKIE_NAME);
  if (token) deleteSession(token);
}

export function buildSessionCookie(token: string, secure: boolean): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [`${COOKIE_NAME}=${token}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie(secure: boolean): string {
  const parts = [`${COOKIE_NAME}=`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(req: http.IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function recordAccess(args: {
  userId: string | null;
  groupId: string | null;
  path: string | null;
  action: string;
  req: http.IncomingMessage;
}): void {
  const fwd = args.req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : null) || args.req.socket.remoteAddress || null;
  logAccess({ userId: args.userId, groupId: args.groupId, path: args.path, action: args.action, ip });
}
