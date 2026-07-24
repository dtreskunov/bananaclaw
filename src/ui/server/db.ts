/**
 * UI auth + audit DB layer (shared across all UI apps mounted under /ui).
 *
 * Sessions and magic links store only sha256(token) — the bearer token is
 * shown to the user exactly once (at issuance) and never persisted in
 * recoverable form. Lookup is by hash, not by id, so an attacker with read
 * access to the DB cannot mint cookies from leaked rows.
 */
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';

export interface UiSession {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_used: string | null;
}

export interface UiMagicLink {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createMagicLink(userId: string, ttlMs: number): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const db = getDb();
  // Supersede any still-valid unredeemed links for this user — only the
  // most recently issued link should work.
  db.prepare("UPDATE ui_magic_links SET redeemed_at = datetime('now') WHERE user_id = ? AND redeemed_at IS NULL").run(
    userId,
  );
  db.prepare(
    `INSERT INTO ui_magic_links (token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hashToken(token), userId, now.toISOString(), expiresAt);
  return { token, expiresAt };
}

/** Atomically consume a magic link. Returns the user_id if valid+unredeemed+unexpired. */
export function redeemMagicLink(token: string): string | null {
  const db = getDb();
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM ui_magic_links WHERE token_hash = ?').get(hash) as UiMagicLink | undefined;
  if (!row) return null;
  if (row.redeemed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const res = db
    .prepare("UPDATE ui_magic_links SET redeemed_at = datetime('now') WHERE token_hash = ? AND redeemed_at IS NULL")
    .run(hash);
  if (res.changes !== 1) return null;
  return row.user_id;
}

export function createSession(userId: string, ttlMs: number): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO ui_sessions (token_hash, user_id, created_at, expires_at, last_used)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(hashToken(token), userId, now.toISOString(), expiresAt, now.toISOString());
  return { token, expiresAt };
}

export function lookupSession(token: string): { tokenHash: string; userId: string; expiresAt: string } | null {
  const hash = hashToken(token);
  const session = lookupSessionByHash(hash);
  if (!session) return null;
  return { tokenHash: hash, ...session };
}

export function lookupSessionByHash(hash: string): { userId: string; expiresAt: string } | null {
  const row = getDb().prepare('SELECT * FROM ui_sessions WHERE token_hash = ?').get(hash) as UiSession | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  // Best-effort touch; not in the hot path enough to batch.
  getDb().prepare("UPDATE ui_sessions SET last_used = datetime('now') WHERE token_hash = ?").run(hash);
  return { userId: row.user_id, expiresAt: row.expires_at };
}

export function deleteSession(token: string): void {
  getDb().prepare('DELETE FROM ui_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function purgeExpired(): void {
  const now = new Date().toISOString();
  getDb().prepare('DELETE FROM ui_sessions WHERE expires_at < ?').run(now);
  getDb().prepare('DELETE FROM ui_magic_links WHERE expires_at < ? OR redeemed_at IS NOT NULL').run(now);
}

export function logAccess(args: {
  userId: string | null;
  groupId: string | null;
  path: string | null;
  action: string;
  ip: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO ui_access_log (user_id, group_id, path, action, ip, ts)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(args.userId, args.groupId, args.path, args.action, args.ip);
}
