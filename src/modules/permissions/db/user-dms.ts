import type { UserDm } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { encodeTimes, decodeTimes, decodeTimeRows } from '../../../db/time.js';

import { recordHostChange } from '../../../db/transaction.js';

export function upsertUserDm(row: UserDm): void {
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (@user_id, @channel_type, @messaging_group_id, @resolved_at)
       ON CONFLICT(user_id, channel_type) DO UPDATE SET
         messaging_group_id = excluded.messaging_group_id,
         resolved_at = excluded.resolved_at`,
    )
    .run(encodeTimes(row, ['resolved_at']));
  recordHostChange({ kind: 'access' });
}

export function getUserDm(userId: string, channelType: string): UserDm | undefined {
  return decodeTimes<UserDm | undefined>(getDb().prepare('SELECT * FROM user_dms WHERE user_id = ? AND channel_type = ?').get(userId, channelType), ['resolved_at']);
}

export function getUserDmsForUser(userId: string): UserDm[] {
  return decodeTimeRows<UserDm>(getDb().prepare('SELECT * FROM user_dms WHERE user_id = ?').all(userId), ['resolved_at']);
}

export function getUserDmByMessagingGroup(messagingGroupId: string): UserDm | undefined {
  return decodeTimes<UserDm | undefined>(getDb().prepare('SELECT * FROM user_dms WHERE messaging_group_id = ?').get(messagingGroupId), ['resolved_at']);
}

export function deleteUserDm(userId: string, channelType: string): void {
  getDb().prepare('DELETE FROM user_dms WHERE user_id = ? AND channel_type = ?').run(userId, channelType);
  recordHostChange({ kind: 'access' });
}
