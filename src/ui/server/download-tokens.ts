/**
 * UI download tokens — file-bound, single-use (configurable), short-TTL
 * download URLs. Distinct from magic links (which are user-bound and mint
 * a cookie) — downloading via token does NOT create a session.
 *
 * Stored as sha256(token); the bearer token is returned once at issuance.
 */
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';
import { toEpoch, decodeTimes } from '../../db/time.js';
import { hashToken } from './db.js';

export interface DownloadTokenRow {
  token_hash: string;
  issuer_user_id: string;
  recipient_user_id: string | null;
  group_id: string;
  rel_path: string;
  created_at: string;
  expires_at: string;
  uses_left: number;
  first_redeemed_at: string | null;
  first_redeemed_ip: string | null;
  first_redeemed_ua: string | null;
}

export function createDownloadToken(args: {
  issuerUserId: string;
  recipientUserId?: string | null;
  groupId: string;
  relPath: string;
  ttlMs: number;
  uses: number;
}): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.ttlMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO ui_download_tokens
         (token_hash, issuer_user_id, recipient_user_id, group_id, rel_path, created_at, expires_at, uses_left)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hashToken(token),
      args.issuerUserId,
      args.recipientUserId ?? null,
      args.groupId,
      args.relPath,
      now.getTime(),
      toEpoch(expiresAt),
      args.uses,
    );
  return { token, expiresAt };
}

/**
 * Atomically consume one use. Returns the token row on success, null on
 * invalid/expired/exhausted. Records IP+UA on first redemption.
 */
export function redeemDownloadToken(token: string, ip: string | null, ua: string | null): DownloadTokenRow | null {
  const db = getDb();
  const hash = hashToken(token);
  const row = decodeTimes<DownloadTokenRow | undefined>(db.prepare('SELECT * FROM ui_download_tokens WHERE token_hash = ?').get(hash), ['created_at', 'expires_at', 'first_redeemed_at']);
  if (!row) return null;
  if (row.uses_left <= 0) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  const res = db
    .prepare(
      `UPDATE ui_download_tokens
         SET uses_left = uses_left - 1,
             first_redeemed_at = COALESCE(first_redeemed_at, ?),
             first_redeemed_ip = COALESCE(first_redeemed_ip, ?),
             first_redeemed_ua = COALESCE(first_redeemed_ua, ?)
       WHERE token_hash = ? AND uses_left > 0`,
    )
    .run(Date.now(), ip, ua, hash);
  if (res.changes !== 1) return null;
  return { ...row, uses_left: row.uses_left - 1, first_redeemed_at: row.first_redeemed_at ?? new Date().toISOString() };
}

export function purgeExpiredDownloadTokens(): void {
  getDb().prepare("DELETE FROM ui_download_tokens WHERE expires_at < ? OR uses_left <= 0").run(Date.now());
}
