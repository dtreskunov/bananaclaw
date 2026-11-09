import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { assertTimestampFields } from '../../../db/validate-timestamps.js';
import { epochMs } from '../../../time.js';
import { recordHostChange } from '../../../db/transaction.js';
import { getIdentitiesForUser } from './identities.js';

export function createUser(user: User): void {
  assertTimestampFields(user, ['created_at']);
  getDb()
    .prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (@id, @kind, @display_name, @created_at)`,
    )
    .run(user);
  recordHostChange({ kind: 'interactions' });
}

export function upsertUser(user: User): void {
  assertTimestampFields(user, ['created_at']);
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
  return getDb().prepare('SELECT id,kind,display_name,created_at,onboarded_at FROM users WHERE id = ?').get(id) as
    | User
    | undefined;
}

export function getUserDisplayName(id: string): string {
  const user = getUser(id);
  if (user?.display_name?.trim()) return user.display_name.trim();
  const identity = getIdentitiesForUser(id).find((identity) => identity.channel !== 'web');
  return identity ? `${identity.channel}:${identity.handle}` : user ? 'Unnamed user' : 'Unavailable user';
}

export function getAllUsers(): User[] {
  return getDb()
    .prepare('SELECT id,kind,display_name,created_at,onboarded_at FROM users ORDER BY created_at')
    .all() as User[];
}

export function updateDisplayName(id: string, displayName: string): void {
  getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
  recordHostChange({ kind: 'interactions' });
}

export function isUserOnboarded(id: string): boolean {
  const row = getDb().prepare('SELECT onboarded_at FROM users WHERE id = ?').get(id) as
    | { onboarded_at: number | null }
    | undefined;
  return row !== undefined && row.onboarded_at !== null;
}

export function markUserOnboarded(id: string): void {
  getDb()
    .prepare('UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?')
    .run(epochMs(Date.now()), id);
}

export function deleteUser(id: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  recordHostChange({ kind: 'access' });
}
