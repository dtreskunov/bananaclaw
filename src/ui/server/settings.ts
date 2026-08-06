/**
 * Settings handler — currently scoped to identity linking (Phase 4b)
 * and profile (display name).
 *
 * Routes (all under `/ui/settings`):
 *
 *   GET    /ui/settings/identities                              → HTML page
 *   GET    /ui/settings/api/identities                          → JSON list
 *   POST   /ui/settings/api/identities/link/start               → {channel, handle}
 *   POST   /ui/settings/api/identities/link/verify              → {challengeId, code}
 *   DELETE /ui/settings/api/identities/:channel/:handle         → unlink
 *   GET    /ui/settings/api/profile                             → { displayName }
 *   PATCH  /ui/settings/api/profile                             → { displayName }
 *   GET    /ui/settings/api/notifications                       → subscription health
 *   POST   /ui/settings/api/notifications/test                  → send a test push
 *
 * All routes require an authenticated UI session — unauthenticated
 * requests get 401 from the API and a 303 → /ui/login from the HTML
 * page. The auth cookie is scoped to /ui so it carries over from /ui/chat.
 *
 * Verification flow:
 *   1. Client POSTs link/start. Server creates a challenge row, DMs a
 *      6-digit code to the claimed (channel, handle).
 *   2. Client POSTs link/verify with the challenge id + code. Server
 *      checks attempts (max 5) + expiry (10 min) + hash, consumes the
 *      row, and inserts an `identities` row owned by the logged-in user.
 *   3. (channel, handle) is the identities PK; a concurrent verify by a
 *      different user will fail naturally on the INSERT.
 *
 * Unlink refuses to remove the user's last identity (which would
 * permanently lock them out of every channel including web).
 */
import http from 'http';
import { URL } from 'url';

import { getActiveAdapters, getRegisteredChannelNames } from '../../channels/channel-registry.js';
import { log } from '../../log.js';
import {
  deleteIdentity,
  getIdentity,
  getIdentitiesForUser,
  insertIdentity,
} from '../../modules/permissions/db/identities.js';
import {
  MAX_ACTIVE_PER_USER,
  MAX_ATTEMPTS,
  countActiveForUser,
  createChallenge,
  createDeepLinkChallenge,
  getChallenge,
  incrementAttempts,
  consumeChallenge,
  verifyCode,
} from '../../modules/permissions/db/identity-link-challenges.js';
import { sendHandleDm } from '../../modules/permissions/handle-dm.js';
import { buildDeepLink, hasDeepLinkBuilder } from '../../modules/permissions/identity-link-deeplinks.js';
import { getUser, updateDisplayName } from '../../modules/permissions/db/users.js';
import { listSubscriptionsForUser } from '../../modules/push/db.js';
import { pushAvailable, sendToUser as sendPushToUser } from '../../modules/push/sender.js';

import { authenticate } from './auth.js';
import { getBranding } from './branding.js';

const SETTINGS_PREFIX = '/ui/settings';
const PROFILE_NAME_MAX = 80;

export async function handleSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  if (pathname.startsWith(SETTINGS_PREFIX)) pathname = pathname.slice(SETTINGS_PREFIX.length) || '/';

  // HTML page (requires auth; bounce to login if missing).
  if (req.method === 'GET' && (pathname === '/identities' || pathname === '/identities/')) {
    const session = authenticate(req);
    if (!session) {
      const next = encodeURIComponent('/ui/settings/identities');
      res.writeHead(303, { Location: `/ui/login?next=${next}` });
      res.end();
      return;
    }
    // The settings page is now embedded in the chat SPA — redirect there
    // with ?settings=1 so the modal opens on first paint.
    res.writeHead(303, { Location: '/ui/chat/?settings=1' });
    res.end();
    return;
  }

  // JSON API.
  if (pathname.startsWith('/api/')) {
    const session = authenticate(req);
    if (!session) return json(res, 401, { error: 'unauthorized' });
    return await handleApi(req, res, pathname.slice('/api'.length), session.userId);
  }

  // Root → chat with settings open.
  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    res.writeHead(303, { Location: '/ui/chat/?settings=1' });
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// ── JSON API ─────────────────────────────────────────────────────────────

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  userId: string,
): Promise<void> {
  if (req.method === 'GET' && pathname === '/notifications') {
    const subscriptions = listSubscriptionsForUser(userId);
    return json(res, 200, {
      available: pushAvailable(),
      count: subscriptions.length,
      failing: subscriptions.filter((subscription) => subscription.fail_count > 0).length,
    });
  }

  if (req.method === 'POST' && pathname === '/notifications/test') {
    if (!pushAvailable()) return json(res, 503, { error: 'push_unavailable' });
    if (listSubscriptionsForUser(userId).length === 0) {
      return json(res, 409, { error: 'no_subscriptions' });
    }
    await sendPushToUser(userId, { v: 1, kind: 'test', ts: new Date().toISOString() });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/identities') {
    const rows = getIdentitiesForUser(userId);
    // Only channels with credentials configured at boot have an active
    // adapter. Registered-but-inactive ones (e.g. Discord without a
    // bot token) shouldn't show up as link options in the UI.
    const availableChannels = getActiveAdapters().map((a) => a.channelType);
    const availableSet = new Set(availableChannels);
    return json(res, 200, {
      identities: rows.map((r) => ({
        channel: r.channel,
        handle: r.handle,
        primary: r.primary_for_channel === 1,
        verified_at: r.verified_at,
      })),
      availableChannels,
      deepLinkChannels: availableChannels.filter((c) => hasDeepLinkBuilder(c)),
    });
  }

  if (req.method === 'POST' && pathname === '/identities/link/start-deeplink') {
    const body = await readJson(req);
    const channel = String(body?.channel || '').trim();
    if (!channel) return json(res, 400, { error: 'channel is required' });
    if (!hasDeepLinkBuilder(channel))
      return json(res, 400, {
        error: 'no_deeplink',
        message: `Channel ${channel} does not support deep-link linking.`,
      });
    if (countActiveForUser(userId) >= MAX_ACTIVE_PER_USER)
      return json(res, 429, {
        error: 'too_many_pending',
        message: `You have ${MAX_ACTIVE_PER_USER} active link requests. Wait for them to expire (10 min) or verify them first.`,
      });
    const { row, token } = createDeepLinkChallenge({ user_id: userId, channel_type: channel });
    const deepLink = await buildDeepLink(channel, token);
    if (!deepLink) {
      log.warn('identity deep-link build failed', { userId, channel, challengeId: row.id });
      return json(res, 502, { error: 'deeplink_failed', message: `Could not build deep link for ${channel}.` });
    }
    log.info('identity deep-link challenge created', { userId, channel, challengeId: row.id });
    return json(res, 200, { challengeId: row.id, channel, deepLink, expiresAt: row.expires_at });
  }

  if (req.method === 'GET' && pathname === '/identities/link/status') {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const challengeId = url.searchParams.get('challengeId') || '';
    if (!challengeId) return json(res, 400, { error: 'challengeId is required' });
    const ch = getChallenge(challengeId);
    if (!ch || ch.user_id !== userId) return json(res, 404, { error: 'not_found' });
    const consumed = !!ch.consumed_at;
    const expired = !consumed && new Date(ch.expires_at).getTime() < Date.now();
    return json(res, 200, {
      consumed,
      expired,
      channel: ch.channel_type,
      handle: ch.handle || null,
      expiresAt: ch.expires_at,
    });
  }

  if (req.method === 'POST' && pathname === '/identities/link/start') {
    const body = await readJson(req);
    const channel = String(body?.channel || '').trim();
    const handle = String(body?.handle || '').trim();
    if (!channel || !handle) return json(res, 400, { error: 'channel and handle are required' });
    if (!getRegisteredChannelNames().includes(channel)) return json(res, 400, { error: `unknown channel: ${channel}` });
    // Already mine?
    const existing = getIdentity(channel, handle);
    if (existing && existing.user_id === userId)
      return json(res, 409, { error: 'identity_already_owned', message: 'You already own this identity.' });
    if (existing) return json(res, 409, { error: 'identity_taken', message: 'Another user owns this identity.' });
    // Rate limit per user.
    if (countActiveForUser(userId) >= MAX_ACTIVE_PER_USER)
      return json(res, 429, {
        error: 'too_many_pending',
        message: `You have ${MAX_ACTIVE_PER_USER} active link requests. Wait for them to expire (10 min) or verify them first.`,
      });
    const { row, code } = createChallenge({ user_id: userId, channel_type: channel, handle });
    const ok = await sendHandleDm(
      channel,
      handle,
      `${getBranding().name} verification code: ${code}\n\nThis code expires in 10 minutes.`,
    );
    if (!ok) {
      // Leave the row for audit; the user will just see a timeout / failure
      // on the next page load. Return a clear error.
      log.warn('identity link DM failed', { userId, channel, handle, challengeId: row.id });
      return json(res, 502, {
        error: 'dm_failed',
        message: `Could not DM ${channel}:${handle}. The channel adapter may be down, or the handle may not exist.`,
      });
    }
    log.info('identity link challenge created', { userId, channel, handle, challengeId: row.id });
    return json(res, 200, {
      challengeId: row.id,
      expiresAt: row.expires_at,
      channel,
      handle,
    });
  }

  if (req.method === 'POST' && pathname === '/identities/link/verify') {
    const body = await readJson(req);
    const challengeId = String(body?.challengeId || '').trim();
    const code = String(body?.code || '').trim();
    if (!challengeId || !code) return json(res, 400, { error: 'challengeId and code are required' });
    const ch = getChallenge(challengeId);
    if (!ch || ch.user_id !== userId) return json(res, 404, { error: 'not_found' });
    if (ch.consumed_at) return json(res, 410, { error: 'already_used' });
    if (new Date(ch.expires_at).getTime() < Date.now()) return json(res, 410, { error: 'expired' });
    const newAttempts = incrementAttempts(challengeId);
    if (newAttempts > MAX_ATTEMPTS) return json(res, 429, { error: 'too_many_attempts' });
    if (!verifyCode(challengeId, code))
      return json(res, 401, { error: 'bad_code', attemptsRemaining: MAX_ATTEMPTS - newAttempts });
    // Race-safe: insertIdentity throws on PK clash (another user verified
    // the same handle first); we wrap and report a clean error.
    try {
      insertIdentity({ userId, channel: ch.channel_type, handle: ch.handle, primary: false });
    } catch (err) {
      log.warn('identity link insertIdentity failed (likely race)', { challengeId, err: (err as Error).message });
      consumeChallenge(challengeId);
      return json(res, 409, { error: 'identity_taken', message: 'Another user claimed this identity first.' });
    }
    consumeChallenge(challengeId);
    log.info('identity linked', { userId, channel: ch.channel_type, handle: ch.handle });
    return json(res, 200, { ok: true, channel: ch.channel_type, handle: ch.handle });
  }

  // DELETE /identities/:channel/:handle (both URL-encoded)
  if (req.method === 'DELETE') {
    const m = pathname.match(/^\/identities\/([^/]+)\/([^/]+)$/);
    if (m) {
      const channel = decodeURIComponent(m[1]);
      const handle = decodeURIComponent(m[2]);
      const row = getIdentity(channel, handle);
      if (!row || row.user_id !== userId) return json(res, 404, { error: 'not_found' });
      const all = getIdentitiesForUser(userId);
      if (all.length <= 1)
        return json(res, 409, {
          error: 'last_identity',
          message: 'Refusing to remove your only identity — you would not be able to sign in again.',
        });
      deleteIdentity(channel, handle);
      log.info('identity unlinked', { userId, channel, handle });
      return json(res, 200, { ok: true });
    }
  }

  // Profile — read + update display name. Kept here (rather than in the
  // chat routes module) so it sits alongside the other Settings-modal
  // endpoints. The onboarding wizard sets display_name once on first
  // sign-in; this is the only post-onboarding edit surface.
  if (req.method === 'GET' && pathname === '/profile') {
    const user = getUser(userId);
    return json(res, 200, { displayName: user?.display_name ?? null });
  }
  if (req.method === 'PATCH' && pathname === '/profile') {
    const body = await readJson(req);
    const raw = body && typeof body.displayName === 'string' ? body.displayName : '';
    const trimmed = raw.trim().slice(0, PROFILE_NAME_MAX);
    if (!trimmed) {
      return json(res, 400, { error: 'display_name_required', message: 'Display name cannot be empty.' });
    }
    updateDisplayName(userId, trimmed);
    log.info('profile display_name updated', { userId });
    return json(res, 200, { displayName: trimmed });
  }

  json(res, 404, { error: 'not_found' });
}

// ── tiny helpers ─────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
