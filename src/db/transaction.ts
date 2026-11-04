import type Database from 'better-sqlite3';
import path from 'node:path';
import { publishHostChange, type HostChange } from '../host-changes.js';
import { getDb } from './connection.js';

const pending = new WeakMap<Database.Database, Map<string, HostChange>>();

/** Nested savepoints accumulate notices; only the outer commit can publish them. */
export function transaction<Args extends unknown[], Result>(
  db: Database.Database,
  operation: (...args: Args) => Result,
): (...args: Args) => Result {
  const execute = db.transaction(operation);
  return (...args) => {
    const parent = pending.get(db);
    if (db.inTransaction && !parent) throw new Error('State transactions must use the shared transaction helper.');
    const changes = new Map<string, HostChange>();
    pending.set(db, changes);
    try {
      const result = execute(...args);
      for (const [key, change] of changes) {
        if (parent) parent.set(key, change);
        else publishHostChange(change);
      }
      return result;
    } finally {
      if (parent) pending.set(db, parent);
      else pending.delete(db);
    }
  };
}

export function recordHostChange(change: HostChange, db: Database.Database = getDb()): void {
  const changes = pending.get(db);
  if (changes) changes.set(JSON.stringify(change), change);
  else {
    if (db.inTransaction) throw new Error('State mutations must use the shared transaction helper.');
    publishHostChange(change);
  }
}

export function recordSessionDatabaseChange(db: Database.Database): void {
  if (db.name === ':memory:') return;
  recordHostChange(
    {
      kind: 'sessions',
      sessionId: path.basename(path.dirname(db.name)),
      groupId: path.basename(path.dirname(path.dirname(db.name))),
    },
    db,
  );
}
