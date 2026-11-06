import type { AgentGroupMember } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { encodeTimes, decodeTimeRows } from '../../../db/time.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

import { recordHostChange } from '../../../db/transaction.js';

export function addMember(row: AgentGroupMember): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (@user_id, @agent_group_id, @added_by, @added_at)`,
    )
    .run(encodeTimes(row, ['added_at']));
  recordHostChange({ kind: 'access' });
}

export function removeMember(userId: string, agentGroupId: string): void {
  getDb().prepare('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?').run(userId, agentGroupId);
  recordHostChange({ kind: 'access' });
}

export function getMembers(agentGroupId: string): AgentGroupMember[] {
  return decodeTimeRows<AgentGroupMember>(getDb()
    .prepare('SELECT * FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at')
    .all(agentGroupId), ['added_at']);
}

/** All membership rows for a user. Does not include implicit admin/owner membership. */
export function getMembershipsForUser(userId: string): AgentGroupMember[] {
  return decodeTimeRows<AgentGroupMember>(getDb()
    .prepare('SELECT * FROM agent_group_members WHERE user_id = ? ORDER BY added_at')
    .all(userId), ['added_at']);
}

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 */
export function isMember(userId: string, agentGroupId: string): boolean {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return true;
  }
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. */
export function hasMembershipRow(userId: string, agentGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1')
    .get(userId, agentGroupId);
  return !!row;
}
