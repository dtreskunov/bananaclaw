import type { Migration } from './index.js';

export const migration053: Migration = {
  version: 53,
  name: 'query-and-foreign-key-indexes',
  up(db) {
    db.exec(`
      CREATE INDEX agent_group_members_group ON agent_group_members(agent_group_id);
      CREATE INDEX messaging_group_agents_group ON messaging_group_agents(agent_group_id);
      CREATE INDEX interactions_group ON interactions(agent_group_id);
      CREATE INDEX conversation_reads_session ON conversation_reads(session_id);
      CREATE INDEX ui_private_web_sessions_parent ON ui_private_web_sessions(parent_ui_session_hash);
      CREATE INDEX ui_sessions_expires ON ui_sessions(expires_at);
      CREATE INDEX ui_magic_links_expires ON ui_magic_links(expires_at);
      CREATE INDEX chat_sdk_kv_expires ON chat_sdk_kv(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX chat_sdk_locks_expires ON chat_sdk_locks(expires_at);
      CREATE INDEX chat_sdk_lists_expires ON chat_sdk_lists(expires_at) WHERE expires_at IS NOT NULL;
    `);
  },
};
