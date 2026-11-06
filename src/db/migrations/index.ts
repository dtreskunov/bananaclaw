import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { CENTRAL_BASELINE_MIGRATION_NAMES, CENTRAL_SCHEMA_SQL } from '../central-schema.js';
import { assertStorageVersion, STORAGE_VERSION } from '../storage-lifecycle.js';
import { transaction } from '../transaction.js';

export interface Migration {
  name: string;
  up: (db: Database.Database) => void;
  /** Table rebuilds need FK enforcement disabled outside their transaction. */
  disableForeignKeys?: boolean;
}

/** Append future named migrations here, in application order. */
export const migrations: Migration[] = [];

export function runMigrations(db: Database.Database, list: Migration[] = migrations): void {
  if (db.inTransaction) throw new Error('Central migrations must own their transaction');
  assertStorageVersion(db, 'central', true);
  if (db.prepare("SELECT 1 FROM pragma_table_info('interactions') WHERE name='expires_at'").get())
    throw new Error(
      'Unsupported interaction expiry storage; stop the host and follow docs/db.md#retiring-interaction-expiry',
    );
  db.pragma('foreign_keys = ON');

  if (db.pragma('user_version', { simple: true }) === 0) {
    transaction(db, () => {
      db.exec(CENTRAL_SCHEMA_SQL);
      db.prepare('INSERT INTO credential_gateway_identity(id,installation_id) VALUES(1,?)').run(randomUUID());
      db.exec('INSERT INTO thread_summary_meta(id,ready,unread_ready) VALUES(1,1,1)');
      const record = db.prepare('INSERT INTO schema_version(version,name,applied) VALUES(?,?,?)');
      const appliedAt = Date.now();
      for (const [index, name] of [...CENTRAL_BASELINE_MIGRATION_NAMES, 'central-baseline-v1'].entries()) {
        record.run(index + 1, name, appliedAt);
      }
      db.pragma(`user_version = ${STORAGE_VERSION}`);
    })();
  }

  const applied = new Set(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((row) => row.name),
  );
  for (const migration of list) {
    if (applied.has(migration.name)) continue;
    if (migration.disableForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      transaction(db, () => {
        const preexisting = new Set(
          migration.disableForeignKeys
            ? (db.pragma('foreign_key_check') as unknown[]).map((row) => JSON.stringify(row))
            : [],
        );
        migration.up(db);
        if (migration.disableForeignKeys) {
          const introduced = (db.pragma('foreign_key_check') as unknown[]).filter(
            (row) => !preexisting.has(JSON.stringify(row)),
          );
          if (introduced.length) {
            throw new Error(
              `migration ${migration.name} left FK violations: ${JSON.stringify(introduced.slice(0, 5))}`,
            );
          }
        }
        db.prepare(
          'INSERT INTO schema_version(version,name,applied) SELECT COALESCE(MAX(version),0)+1,?,? FROM schema_version',
        ).run(migration.name, Date.now());
      })();
      applied.add(migration.name);
    } finally {
      if (migration.disableForeignKeys) db.pragma('foreign_keys = ON');
    }
    log.info('Migration applied', { name: migration.name });
  }
}
