import type { Migration } from './index.js';

export const migration047: Migration = {
  version: 47,
  name: 'approval-history',
  up(db) {
    db.exec(`
      CREATE TABLE approval_history (
        approval_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        origin_message_id TEXT,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        title TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','applying','approved','rejected','failed','cancelled','expired')),
        decision TEXT,
        responded_by TEXT,
        response_message TEXT,
        outcome_message TEXT,
        resolved_at TEXT
      );
      CREATE INDEX approval_history_session ON approval_history(session_id,created_at);
      INSERT INTO approval_history(
        approval_id,session_id,origin_message_id,action,payload,title,options_json,created_at,status,
        responded_by,response_message,outcome_message,resolved_at)
      SELECT a.approval_id,a.session_id,
        COALESCE(a.origin_message_id,json_extract(w.origin_json,'$.messageId')),
        a.action,a.payload,a.title,a.options_json,a.created_at,
        CASE w.stage WHEN 'completed' THEN 'approved' WHEN 'applying' THEN 'applying'
          WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' WHEN 'expired' THEN 'expired'
          WHEN 'rejected' THEN 'rejected' ELSE a.status END,
        COALESCE(json_extract(w.result_json,'$.response_message.userId'),json_extract(w.data_json,'$.userId')),
        json_extract(w.result_json,'$.response_message.message'),
        json_extract(w.result_json,'$.message'),
        CASE WHEN a.status!='pending' THEN w.updated_at END
      FROM pending_approvals a LEFT JOIN approval_workflows w ON w.approval_id=a.approval_id
      WHERE a.session_id IS NOT NULL;
    `);
  },
};
