import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

const SHARED_WEB_PLATFORM_PREFIX = 'group:';
const SHARED_WEB_MESSAGING_GROUP_PREFIX = 'mg-web-shared-';
const SHARED_WEB_WIRING_PREFIX = 'mga-web-shared-';

/**
 * Collapse per-user web messaging groups into one shared web room per agent
 * group. Session ids and thread ids stay unchanged, so their on-disk databases
 * and complete transcripts remain in place.
 */
export const migration029: Migration = {
  version: 29,
  name: 'shared-web-chats',
  up: (db: Database.Database) => {
    const groups = db.prepare('SELECT id FROM agent_groups').all() as { id: string }[];
    const insertMessagingGroup = db.prepare(`
      INSERT OR IGNORE INTO messaging_groups
        (id, channel_type, platform_id, instance, name, is_group,
         unknown_sender_policy, denied_at, created_at)
      VALUES (?, 'web', ?, 'web', NULL, 1, 'strict', NULL, ?)
    `);
    const insertWiring = db.prepare(`
      INSERT OR IGNORE INTO messaging_group_agents
        (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
         sender_scope, ignored_message_policy, session_mode, priority, created_at)
      VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'per-thread', 0, ?)
    `);
    const moveSessions = db.prepare(`
      UPDATE sessions
         SET messaging_group_id = ?
       WHERE agent_group_id = ?
         AND messaging_group_id IN (
           SELECT mg.id
             FROM messaging_groups mg
             JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
            WHERE mga.agent_group_id = ? AND mg.channel_type = 'web'
         )
    `);
    const removeOldWirings = db.prepare(`
      DELETE FROM messaging_group_agents
       WHERE agent_group_id = ?
         AND messaging_group_id != ?
         AND messaging_group_id IN (
           SELECT id FROM messaging_groups WHERE channel_type = 'web'
         )
    `);

    const createdAt = new Date().toISOString();
    for (const group of groups) {
      const messagingGroupId = `${SHARED_WEB_MESSAGING_GROUP_PREFIX}${group.id}`;
      const platformId = `${SHARED_WEB_PLATFORM_PREFIX}${group.id}`;
      insertMessagingGroup.run(messagingGroupId, platformId, createdAt);
      insertWiring.run(`${SHARED_WEB_WIRING_PREFIX}${group.id}`, messagingGroupId, group.id, createdAt);
      moveSessions.run(messagingGroupId, group.id, group.id);
      removeOldWirings.run(group.id, messagingGroupId);
    }
  },
};
