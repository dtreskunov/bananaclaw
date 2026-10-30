import type { Migration } from './index.js';

export const migration045: Migration = {
  version: 45,
  name: 'approval-workflows',
  up(db) {
    db.exec(`
      CREATE TABLE approval_workflows (
        approval_id TEXT PRIMARY KEY REFERENCES pending_approvals(approval_id) ON DELETE CASCADE,
        dedupe_key TEXT NOT NULL,
        origin_json TEXT NOT NULL DEFAULT '{}',
        stage TEXT NOT NULL DEFAULT 'pending'
          CHECK(stage IN ('pending','applying','completed','rejected','cancelled','expired','failed')),
        revision INTEGER NOT NULL DEFAULT 1,
        data_json TEXT NOT NULL DEFAULT '{}',
        submission_ids_json TEXT NOT NULL DEFAULT '[]',
        result_json TEXT,
        notified INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX approval_workflows_pending_key ON approval_workflows(dedupe_key)
        WHERE stage IN ('pending','applying');
    `);
  },
};
