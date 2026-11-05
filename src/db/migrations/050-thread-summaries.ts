import type { Migration } from './index.js';

export const THREAD_SUMMARY_SCHEMA = `
CREATE TABLE thread_summaries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('inbound', 'outbound')),
  kind TEXT NOT NULL CHECK (kind IN ('route', 'usage', 'turn')),
  channel_type TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (session_id, source, kind, channel_type, platform_id, thread_id)
);
CREATE TABLE thread_summary_status (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  error TEXT
);
CREATE TABLE thread_summary_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1))
);
INSERT INTO thread_summary_meta SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM sessions) THEN 0 ELSE 1 END;
`;

export const migration050: Migration = {
  version: 50,
  name: 'maintained-thread-summaries',
  up(db) {
    db.exec(THREAD_SUMMARY_SCHEMA);
  },
};
