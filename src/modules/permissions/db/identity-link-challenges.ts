/**
 * Identity-link challenge CRUD. A challenge is a short-lived (default
 * 10 min) verification record created when a logged-in user wants to
 * claim a (channel_type, handle). The code is DM'd to the claimed handle
 * in plaintext and stored here as `sha256` only.
 *
 * `consumed_at` non-null = successful verify; the row stays for audit
 * but won't validate a second time.
 */
import { createHash, randomUUID } from 'node:crypto';

import { getDb } from '../../../db/connection.js';
import { toEpoch, decodeTimes, decodeTimeRows } from '../../../db/time.js';

export interface IdentityLinkChallenge {
  id: string;
  user_id: string;
  channel_type: string;
  handle: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  created_at: string;
  consumed_at: string | null;
}

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_ACTIVE_PER_USER = 3;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Six-digit numeric code. Padded so leading zeros survive. */
export function generateCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

/**
 * Long URL-safe token for deep-link challenges (channels where the bot
 * cannot DM by handle — e.g. Telegram, where we send the user to
 * `t.me/<bot>?start=link-<token>`). 12 hex chars = 48 bits of entropy:
 * collision-resistant for the small population of concurrent active
 * challenges, and short enough to remain a tidy URL.
 */
export function generateDeepLinkToken(): string {
  // 6 random bytes → 12 lowercase hex chars
  const arr = new Uint8Array(6);
  // Node 22 has globalThis.crypto; fall back to randomUUID slice on weird envs.
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(arr);
  else {
    const r = randomUUID().replace(/-/g, '');
    for (let i = 0; i < 6; i++) arr[i] = parseInt(r.slice(i * 2, i * 2 + 2), 16);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function countActiveForUser(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM identity_link_challenges
       WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .get(userId, Date.now()) as { n: number };
  return row.n;
}

export function listActiveForUser(userId: string): IdentityLinkChallenge[] {
  return decodeTimeRows<IdentityLinkChallenge>(getDb()
    .prepare(
      `SELECT * FROM identity_link_challenges
       WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(userId, Date.now()), ['expires_at', 'created_at', 'consumed_at']);
}

export function getChallenge(id: string): IdentityLinkChallenge | undefined {
  return decodeTimes<IdentityLinkChallenge | undefined>(getDb().prepare('SELECT * FROM identity_link_challenges WHERE id = ?').get(id), ['expires_at', 'created_at', 'consumed_at']);
}

export function createChallenge(args: { user_id: string; channel_type: string; handle: string; ttl_ms?: number }): {
  row: IdentityLinkChallenge;
  code: string;
} {
  const code = generateCode();
  const id = `ilc-${randomUUID()}`;
  const ttl = args.ttl_ms ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  getDb()
    .prepare(
      `INSERT INTO identity_link_challenges
       (id, user_id, channel_type, handle, code_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, args.user_id, args.channel_type, args.handle, sha256Hex(code), toEpoch(expiresAt));
  return { row: getChallenge(id)!, code };
}

/**
 * Increment attempts; return the new count. Caller should reject the
 * challenge when it crosses MAX_ATTEMPTS.
 */
export function incrementAttempts(id: string): number {
  getDb().prepare('UPDATE identity_link_challenges SET attempts = attempts + 1 WHERE id = ?').run(id);
  const row = getChallenge(id);
  return row ? row.attempts : 0;
}

export function verifyCode(id: string, plaintext: string): boolean {
  const row = getChallenge(id);
  if (!row) return false;
  return row.code_hash === sha256Hex(plaintext);
}

export function consumeChallenge(id: string): void {
  getDb().prepare(`UPDATE identity_link_challenges SET consumed_at = ? WHERE id = ?`).run(Date.now(), id);
}

/**
 * Deep-link challenge: handle is unknown until the user lands in the
 * channel and triggers a /start (or equivalent). We store the empty
 * string as a sentinel for `handle`, fill it in at consume time.
 */
export function createDeepLinkChallenge(args: { user_id: string; channel_type: string; ttl_ms?: number }): {
  row: IdentityLinkChallenge;
  token: string;
} {
  const token = generateDeepLinkToken();
  const id = `ilc-${randomUUID()}`;
  const ttl = args.ttl_ms ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();
  getDb()
    .prepare(
      `INSERT INTO identity_link_challenges
       (id, user_id, channel_type, handle, code_hash, expires_at)
       VALUES (?, ?, ?, '', ?, ?)`,
    )
    .run(id, args.user_id, args.channel_type, sha256Hex(token), toEpoch(expiresAt));
  return { row: getChallenge(id)!, token };
}

/**
 * Find an active deep-link challenge by plaintext token. Used by the
 * channel adapter when the user lands in the channel and presents the
 * token. Returns null when no match, or when more than one row matches
 * (ambiguous → reject for safety).
 */
export function findActiveDeepLinkChallengeByCode(
  channel_type: string,
  plaintext: string,
): IdentityLinkChallenge | null {
  const rows = decodeTimeRows<IdentityLinkChallenge>(getDb()
    .prepare(
      `SELECT * FROM identity_link_challenges
       WHERE channel_type = ? AND handle = '' AND code_hash = ?
         AND consumed_at IS NULL AND expires_at > ?
       LIMIT 2`,
    )
    .all(channel_type, sha256Hex(plaintext), Date.now()), ['expires_at', 'created_at', 'consumed_at']);
  if (rows.length !== 1) return null;
  return rows[0];
}

/** Fill in the resolved handle once a deep-link challenge has been claimed. */
export function setChallengeHandle(id: string, handle: string): void {
  getDb().prepare('UPDATE identity_link_challenges SET handle = ? WHERE id = ?').run(handle, id);
}
