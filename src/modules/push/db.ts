/**
 * DB access for `push_subscriptions` (Web Push registrations from the
 * PWA service worker). One row per browser endpoint; user_id ties it to
 * the authenticated UI session. Pure SQL helpers — no `web-push` imports
 * here, those live in sender.ts.
 */
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';
import { decodeTimes, decodeTimeRows } from '../../db/time.js';

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string | null;
  created_at: string;
  last_used_at: string | null;
  last_error: string | null;
  fail_count: number;
}

export interface UpsertSubscriptionInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  ua?: string | null;
}

/** Idempotent: re-binds an existing endpoint to the current user/keys. */
export function upsertSubscription(input: UpsertSubscriptionInput): PushSubscriptionRow {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint) as
    | PushSubscriptionRow
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE push_subscriptions
         SET user_id = ?, p256dh = ?, auth = ?, ua = ?, last_used_at = ?, last_error = NULL, fail_count = 0
         WHERE id = ?`,
    ).run(input.userId, input.p256dh, input.auth, input.ua ?? null, now, existing.id);
    return decodeTimes<PushSubscriptionRow>(db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(existing.id), ['created_at', 'last_used_at']);
  }
  const id = `pushsub-${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, ua, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.userId, input.endpoint, input.p256dh, input.auth, input.ua ?? null, now);
  return decodeTimes<PushSubscriptionRow>(db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id), ['created_at', 'last_used_at']);
}

export function deleteSubscriptionByEndpoint(endpoint: string): void {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function listSubscriptionsForUser(userId: string): PushSubscriptionRow[] {
  return decodeTimeRows<PushSubscriptionRow>(getDb()
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at')
    .all(userId), ['created_at', 'last_used_at']);
}

export function markSubscriptionFailure(endpoint: string, err: string): number {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE push_subscriptions
         SET fail_count = fail_count + 1, last_error = ?, last_used_at = ?
         WHERE endpoint = ?
         RETURNING fail_count`,
    )
    .get(err.slice(0, 500), now, endpoint) as { fail_count: number } | undefined;
  return result?.fail_count ?? 0;
}

export function markSubscriptionSuccess(endpoint: string): void {
  getDb()
    .prepare('UPDATE push_subscriptions SET last_used_at = ?, last_error = NULL WHERE endpoint = ?')
    .run(Date.now(), endpoint);
}

export function pruneExpiredSubscriptions(maxFails: number, idleDays: number): number {
  const cutoff = Date.now() - idleDays * 86400_000;
  const result = getDb()
    .prepare(
      `DELETE FROM push_subscriptions
        WHERE fail_count >= ?
           OR (last_used_at IS NOT NULL AND last_used_at < ?)
           OR (last_used_at IS NULL AND created_at < ?)`,
    )
    .run(maxFails, cutoff, cutoff);
  return result.changes;
}
