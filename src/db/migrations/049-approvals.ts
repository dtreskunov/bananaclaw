import type { Migration } from './index.js';

export const migration049: Migration = {
  version: 49,
  name: 'retained-approvals',
  up(db) {
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('pending_approvals','approval_history','approval_workflows')",
        )
        .get()
    )
      throw new Error('Legacy approval storage requires the offline cutover in docs/user-requests-refactor-plan.md');
    db.exec(`
      CREATE TABLE approvals (
        approval_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'confirmation' CHECK(kind IN ('confirmation','account_setup','access_grant')),
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        agent_group_id TEXT REFERENCES agent_groups(id),
        origin_message_id TEXT,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        options_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','applying','approved','completed','rejected','failed','cancelled','expired')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        dedupe_key TEXT,
        decision TEXT,
        responded_by TEXT,
        response_message TEXT,
        outcome_message TEXT,
        resolved_at TEXT,
        CHECK((kind='confirmation' AND status!='completed') OR (kind!='confirmation' AND status!='approved'))
      );
      CREATE INDEX approvals_session ON approvals(session_id,created_at);
      CREATE INDEX approvals_action_status ON approvals(action,status);
      CREATE UNIQUE INDEX approvals_pending_key ON approvals(dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('pending','applying');
      CREATE TABLE approval_workflows (
        approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
        data_json TEXT NOT NULL DEFAULT '{}',
        submission_ids_json TEXT NOT NULL DEFAULT '[]',
        restart INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
};
