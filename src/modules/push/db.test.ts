import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { pruneExpiredSubscriptions, upsertSubscription } from './db.js';

afterEach(() => closeDb());

describe('push subscription pruning', () => {
  it('removes abandoned subscriptions while retaining recently refreshed ones', () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES ('user-1', 'web', 'User', datetime('now'))`,
    ).run();
    upsertSubscription({ userId: 'user-1', endpoint: 'https://push.test/old', p256dh: 'key', auth: 'auth' });
    upsertSubscription({ userId: 'user-1', endpoint: 'https://push.test/current', p256dh: 'key', auth: 'auth' });
    db.prepare(
      `UPDATE push_subscriptions
          SET created_at = datetime('now', '-91 days'), last_used_at = datetime('now', '-91 days')
        WHERE endpoint = 'https://push.test/old'`,
    ).run();

    expect(pruneExpiredSubscriptions(5, 90)).toBe(1);
    expect(db.prepare('SELECT endpoint FROM push_subscriptions ORDER BY endpoint').all()).toEqual([
      { endpoint: 'https://push.test/current' },
    ]);
  });
});
