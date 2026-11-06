/**
 * Identity model — separates "who the user is" (a UUID in `users.id`) from
 * "how they're addressable" (one or more `(channel, handle)` rows in
 * `identities`). One human can have many identities.
 *
 * All inbound-message paths should resolve users via {@link getOrCreateUserByIdentity}.
 * String concatenation like `${channel}:${handle}` to form a user id is no
 * longer valid and will not match anything in the DB.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../../db/connection.js';
import { decodeTimes, decodeTimeRows } from '../../../db/time.js';

import { recordHostChange, transaction } from '../../../db/transaction.js';

export interface Identity {
  user_id: string;
  channel: string;
  handle: string;
  verified_at: string;
  primary_for_channel: number;
  metadata_json: string | null;
}

export function getIdentity(channel: string, handle: string): Identity | undefined {
  return decodeTimes<Identity | undefined>(getDb().prepare('SELECT * FROM identities WHERE channel = ? AND handle = ?').get(channel, handle), ['verified_at']);
}

export function getIdentitiesForUser(userId: string): Identity[] {
  return decodeTimeRows<Identity>(getDb()
    .prepare('SELECT * FROM identities WHERE user_id = ? ORDER BY channel, handle')
    .all(userId), ['verified_at']);
}

/**
 * The DM-target identity to use when delivering to this user on a given
 * channel: prefer one marked `primary_for_channel=1`, else the
 * earliest-verified.
 */
export function getPrimaryIdentityForChannel(userId: string, channel: string): Identity | undefined {
  return decodeTimes<Identity | undefined>(getDb()
    .prepare(
      `SELECT * FROM identities
       WHERE user_id = ? AND channel = ?
       ORDER BY primary_for_channel DESC, verified_at ASC
       LIMIT 1`,
    )
    .get(userId, channel), ['verified_at']);
}

export function insertIdentity(args: {
  userId: string;
  channel: string;
  handle: string;
  primary?: boolean;
  metadata?: Record<string, unknown> | null;
}): void {
  const db = getDb();
  transaction(db, () => {
    if (args.primary) {
      db.prepare('UPDATE identities SET primary_for_channel=0 WHERE user_id=? AND channel=?').run(
        args.userId,
        args.channel,
      );
    }
    db.prepare(
      `INSERT INTO identities (user_id, channel, handle, verified_at, primary_for_channel, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.userId,
      args.channel,
      args.handle,
      Date.now(),
      (args.primary ?? false) ? 1 : 0,
      args.metadata ? JSON.stringify(args.metadata) : null,
    );
  })();
  recordHostChange({ kind: 'access' });
}

export function deleteIdentity(channel: string, handle: string): void {
  getDb().prepare('DELETE FROM identities WHERE channel = ? AND handle = ?').run(channel, handle);
  recordHostChange({ kind: 'access' });
}

/**
 * Find an existing user by `(channel, handle)`, or create a brand-new user
 * with that identity. Returns the user's UUID.
 *
 * - `displayName` is only used when creating; it never overwrites an
 *   existing user's display name.
 * - Existing users get their `display_name` filled in if it was previously
 *   null and a displayName is provided.
 */
export function getOrCreateUserByIdentity(args: {
  channel: string;
  handle: string;
  displayName?: string | null;
  metadata?: Record<string, unknown> | null;
}): string {
  const db = getDb();
  const existing = getIdentity(args.channel, args.handle);
  if (existing) {
    if (args.displayName) {
      db.prepare(`UPDATE users SET display_name = COALESCE(display_name, ?) WHERE id = ?`).run(
        args.displayName,
        existing.user_id,
      );
      recordHostChange({ kind: 'interactions' });
    }
    return existing.user_id;
  }

  const userId = randomUUID();
  const now = Date.now();

  transaction(db, () => {
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`).run(
      userId,
      args.channel,
      args.displayName ?? null,
      now,
    );
    db.prepare(
      `INSERT INTO identities (user_id, channel, handle, verified_at, primary_for_channel, metadata_json)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(userId, args.channel, args.handle, now, args.metadata ? JSON.stringify(args.metadata) : null);
  })();

  recordHostChange({ kind: 'access' });
  return userId;
}
