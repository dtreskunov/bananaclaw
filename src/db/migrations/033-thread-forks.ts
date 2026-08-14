import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Thread lineage for forked chats.
 *
 * No FK to sessions: the row is keyed by thread id (not session id) and must
 * outlive the parent so a surviving fork can still render "forked from a
 * deleted thread". Thread ids are UUIDs and never reused, so a dangling
 * parent pointer can't alias a different thread later.
 */
export const migration033: Migration = {
  version: 33,
  name: 'thread-forks',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE thread_forks (
        agent_group_id     TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        thread_id          TEXT NOT NULL,
        parent_thread_id   TEXT NOT NULL,
        parent_message_id  TEXT NOT NULL,
        parent_message_ts  TEXT NOT NULL,
        parent_title       TEXT,
        fidelity           TEXT NOT NULL DEFAULT 'transcript',
        created_at         TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, messaging_group_id, thread_id)
      );
      CREATE INDEX idx_thread_forks_parent
        ON thread_forks(agent_group_id, messaging_group_id, parent_thread_id);
    `);
  },
};
