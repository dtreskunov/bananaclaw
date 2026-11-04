import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

import { recordHostChange } from '../../../db/transaction.js';

export function createUser(user: User): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)`,
    )
    .run(user);
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
    .run(user);
  recordHostChange({ kind: 'interactions' });
}

export function getUser(id: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getAllUsers(): User[] {
  return getDb().prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
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
  getDb().prepare("UPDATE users SET onboarded_at = COALESCE(onboarded_at, datetime('now')) WHERE id = ?").run(id);
}

export function deleteUser(id: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  recordHostChange({ kind: 'access' });
}
