import type { Migration } from './index.js';

export const migration051: Migration = {
  version: 51,
  name: 'durable-conversation-reads',
  up(db) {
    db.exec(`
      CREATE TABLE conversation_publications (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('message','question','approval')),
        item_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
        UNIQUE(session_id,kind,item_id,channel_type,platform_id,thread_id)
      );
      CREATE INDEX conversation_publications_route
        ON conversation_publications(session_id,channel_type,thread_id,platform_id,visible,position);
      CREATE TABLE conversation_reads (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        channel_type TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position>=0),
        PRIMARY KEY(user_id,session_id,channel_type,platform_id,thread_id)
      );
      ALTER TABLE users ADD COLUMN unread_baseline INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE interactions ADD COLUMN route_origin_id TEXT;
      CREATE TRIGGER users_unread_baseline AFTER INSERT ON users BEGIN
        UPDATE users SET unread_baseline=(SELECT COALESCE(MAX(position),0) FROM conversation_publications)
          WHERE id=NEW.id;
      END;
      ALTER TABLE thread_summary_meta ADD COLUMN unread_ready INTEGER NOT NULL DEFAULT 0;
      UPDATE thread_summary_meta SET unread_ready=CASE WHEN EXISTS(SELECT 1 FROM sessions) THEN 0 ELSE 1 END;
    `);
  },
};
