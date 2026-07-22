import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

const SHARED_WEB_MESSAGING_GROUP_PREFIX = 'mg-web-shared-';

/**
 * Repair destination maps after migration 029 collapsed per-user web rooms.
 * The old destination rows otherwise keep projecting legacy platform IDs, so
 * inbound messages from the shared room cannot be mapped back to a reply target.
 */
export const migration030: Migration = {
  version: 30,
  name: 'shared-web-destinations',
  up: (db: Database.Database) => {
    const groups = db.prepare('SELECT id FROM agent_groups').all() as { id: string }[];
    const deleteLegacyWebDestinations = db.prepare(`
      DELETE FROM agent_destinations
       WHERE agent_group_id = ?
         AND target_type = 'channel'
         AND target_id != ?
         AND target_id IN (
           SELECT id FROM messaging_groups WHERE channel_type = 'web'
         )
    `);
    const findByTarget = db.prepare(`
      SELECT 1
        FROM agent_destinations
       WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?
       LIMIT 1
    `);
    const findByName = db.prepare(`
      SELECT 1
        FROM agent_destinations
       WHERE agent_group_id = ? AND local_name = ?
       LIMIT 1
    `);
    const insertDestination = db.prepare(`
      INSERT INTO agent_destinations
        (agent_group_id, local_name, target_type, target_id, created_at)
      VALUES (?, ?, 'channel', ?, ?)
    `);
    const messagingGroupExists = db.prepare(
      `SELECT 1 FROM messaging_groups WHERE id = ? AND channel_type = 'web' LIMIT 1`,
    );

    const createdAt = new Date().toISOString();
    for (const group of groups) {
      const messagingGroupId = `${SHARED_WEB_MESSAGING_GROUP_PREFIX}${group.id}`;
      if (!messagingGroupExists.get(messagingGroupId)) continue;

      deleteLegacyWebDestinations.run(group.id, messagingGroupId);
      if (findByTarget.get(group.id, messagingGroupId)) continue;

      const baseName = `web-${messagingGroupId.slice(0, 8)}`;
      let localName = baseName;
      let suffix = 2;
      while (findByName.get(group.id, localName)) {
        localName = `${baseName}-${suffix}`;
        suffix++;
      }
      insertDestination.run(group.id, localName, messagingGroupId, createdAt);
    }
  },
};
