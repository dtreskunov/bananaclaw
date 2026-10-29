import { randomUUID } from 'node:crypto';
import type { Migration } from './index.js';

export const moduleCredentialConnections: Migration = {
  version: 37,
  name: 'credential-connections-identity',
  up(db) {
    db.exec(`
      CREATE TABLE credential_gateway_identity (
        id INTEGER PRIMARY KEY CHECK(id=1),
        installation_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE credential_gateway_sync (
        user_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO credential_gateway_sync(user_id) SELECT id FROM users;
    `);
    db.prepare('INSERT INTO credential_gateway_identity(id,installation_id) VALUES(1,?)').run(randomUUID());
    for (const [table, column] of [
      ['users', 'id'],
      ['user_roles', 'user_id'],
      ['agent_group_members', 'user_id'],
    ]) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`
          CREATE TRIGGER credential_sync_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN
            INSERT INTO credential_gateway_sync(user_id) VALUES(${row}.${column})
            ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
          END;
        `);
      }
    }
    for (const operation of ['INSERT', 'DELETE']) {
      db.exec(`
        CREATE TRIGGER credential_sync_groups_${operation.toLowerCase()}
        AFTER ${operation} ON agent_groups BEGIN
          INSERT INTO credential_gateway_sync(user_id)
          SELECT id FROM users WHERE 1
          ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
        END;
      `);
    }
  },
};
