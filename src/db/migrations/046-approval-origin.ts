import type { Migration } from './index.js';

export const migration046: Migration = {
  version: 46,
  name: 'approval-origin',
  up(db) {
    db.exec('ALTER TABLE pending_approvals ADD COLUMN origin_message_id TEXT');
  },
};
