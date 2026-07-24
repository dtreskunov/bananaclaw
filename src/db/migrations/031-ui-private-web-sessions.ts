import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration031: Migration = {
  version: 31,
  name: 'ui-private-web-sessions',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE ui_private_web_sessions (
        id                     TEXT PRIMARY KEY,
        handoff_token_hash     TEXT NOT NULL UNIQUE,
        secure_token_hash      TEXT UNIQUE,
        parent_ui_session_hash TEXT NOT NULL REFERENCES ui_sessions(token_hash) ON DELETE CASCADE,
        user_id                TEXT NOT NULL REFERENCES users(id),
        agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        created_at             TEXT NOT NULL,
        expires_at             TEXT NOT NULL,
        last_used              TEXT,
        redeemed_at            TEXT
      );
      CREATE INDEX idx_ui_private_web_sessions_expires
        ON ui_private_web_sessions(expires_at);
    `);
  },
};
