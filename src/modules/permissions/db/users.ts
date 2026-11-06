import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { encodeTimes, decodeTimes, decodeTimeRows } from '../../../db/time.js';

import { recordHostChange } from '../../../db/transaction.js';

export function createUser(user: User): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)`,
    )
    .run(encodeTimes(user, ['created_at']));
  recordHostChange({ kind: 'interactions' });
}

export function upsertUser(user: User): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name)`,
    )
    .run(encodeTimes(user, ['created_at']));
  recordHostChange({ kind: 'interactions' });
}

export function getUser(id: string): User | undefined {
  return decodeTimes<User | undefined>(getDb().prepare('SELECT id,kind,display_name,created_at,onboarded_at FROM users WHERE id = ?').get(id), ['created_at', 'onboarded_at']);
}

export function getAllUsers(): User[] {
  return decodeTimeRows<User>(getDb().prepare('SELECT id,kind,display_name,created_at,onboarded_at FROM users ORDER BY created_at').all(), ['created_at', 'onboarded_at']);
}

export function updateDisplayName(id: string, displayName: string): void {
  getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
  recordHostChange({ kind: 'interactions' });
}

export function isUserOnboarded(id: string): boolean {
  const row = getDb().prepare('SELECT onboarded_at FROM users WHERE id = ?').get(id) as
    | { onboarded_at: string | null }
    | undefined;
  return !!row?.onboarded_at;
}

export function markUserOnboarded(id: string): void {
  getDb().prepare("UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?").run(Date.now(), id);
}

export function deleteUser(id: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  recordHostChange({ kind: 'access' });
}
