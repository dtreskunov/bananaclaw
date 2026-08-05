import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/** Per-agent Resend address: <email_slug>@<configured Resend domain>. */
export const migration032: Migration = {
  version: 32,
  name: 'agent-email',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE agent_groups ADD COLUMN email_slug TEXT;
      ALTER TABLE agent_groups ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX idx_agent_groups_email_slug ON agent_groups(email_slug) WHERE email_slug IS NOT NULL;

      CREATE TABLE resend_outbound_correlations (
        correlation_token TEXT PRIMARY KEY,
        origin_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        email_thread_id   TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
    `);
  },
};
