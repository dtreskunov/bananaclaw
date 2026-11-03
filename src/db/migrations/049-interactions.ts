import type { Migration } from './index.js';

export const migration049: Migration = {
  version: 49,
  name: 'current-state-interactions',
  up(db) {
    if (
      db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type='table'
      AND name IN ('questions','pending_questions','approvals','pending_approvals','approval_history','approval_workflows')`,
        )
        .get()
    )
      throw new Error(
        'Interaction storage requires the explicit offline cutover in docs/user-requests-refactor-plan.md',
      );
    db.exec(INTERACTION_SCHEMA);
  },
};

export const INTERACTION_SCHEMA = `
      CREATE TABLE interactions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('question','confirmation','account_setup','access_grant')),
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        agent_group_id TEXT REFERENCES agent_groups(id),
        origin_message_id TEXT,
        request_id TEXT,
        message_out_id TEXT,
        in_reply_to TEXT,
        platform_id TEXT,
        channel_type TEXT,
        thread_id TEXT,
        input_json TEXT NOT NULL CHECK(json_valid(input_json)),
        response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
        status TEXT NOT NULL DEFAULT 'pending',
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        dedupe_key TEXT,
        responded_by TEXT,
        responded_at TEXT,
        outcome_message TEXT,
        resolved_at TEXT,
        CHECK(COALESCE((
          (kind='question' AND session_id IS NOT NULL AND message_out_id IS NOT NULL
            AND status IN ('pending','answered','cancelled')
            AND ((status='answered' AND response_json IS NOT NULL AND responded_at IS NOT NULL
              AND json_extract(response_json,'$.responseType') IN ('choice','text','skipped')
              AND CASE WHEN json_extract(response_json,'$.responseType')='skipped'
                THEN json_type(response_json,'$.value') IS NULL
                ELSE json_type(response_json,'$.value')='text' END)
              OR (status!='answered' AND response_json IS NULL)))
          OR (kind!='question' AND request_id IS NOT NULL AND response_json IS NOT NULL
            AND status IN ('pending','applying','approved','completed','rejected','failed','cancelled','expired')
            AND ((kind='confirmation' AND status!='completed') OR (kind!='confirmation' AND status!='approved')))
        ),0))
      );
      CREATE INDEX interactions_session ON interactions(session_id,created_at,id);
      CREATE INDEX interactions_pending_question ON interactions(session_id)
        WHERE kind='question' AND status='pending';
      CREATE UNIQUE INDEX interactions_pending_key ON interactions(dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('pending','applying');
      CREATE TABLE interaction_progress (
        id TEXT PRIMARY KEY REFERENCES interactions(id) ON DELETE CASCADE,
        data_json TEXT NOT NULL DEFAULT '{}',
        submission_ids_json TEXT NOT NULL DEFAULT '[]',
        restart INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0
      );
    `;
