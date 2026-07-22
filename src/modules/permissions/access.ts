/**
 * Access control.
 *
 * Privilege is user-level, not group-level. A user holds zero or more roles
 * (owner | admin) via `user_roles`, and is optionally "known" in specific
 * agent groups via `agent_group_members`. Admins are implicitly members of
 * the groups they administer.
 *
 * Approver-picking (`pickApprover`, `pickApprovalDelivery`) lives in the
 * approvals module — see `src/modules/approvals/primitive.ts`.
 */
import { getMembershipsForUser, hasMembershipRow, isMember } from './db/agent-group-members.js';
import { getUserRoles, isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './db/user-roles.js';
import { getUser } from './db/users.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import type { AgentGroup } from '../../types.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'global_admin' | 'admin_of_group' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'not_member' };

/** Can this user interact with this agent group? */
export function canAccessAgentGroup(userId: string, agentGroupId: string): AccessDecision {
  if (!getUser(userId)) return { allowed: false, reason: 'unknown_user' };
  if (isOwner(userId)) return { allowed: true, reason: 'owner' };
  if (isGlobalAdmin(userId)) return { allowed: true, reason: 'global_admin' };
  if (isAdminOfAgentGroup(userId, agentGroupId)) return { allowed: true, reason: 'admin_of_group' };
  if (isMember(userId, agentGroupId)) return { allowed: true, reason: 'member' };
  return { allowed: false, reason: 'not_member' };
}

/** Access granted directly by group membership or a group-scoped admin role. */
export function hasDirectAgentGroupAccess(userId: string, agentGroupId: string): boolean {
  if (!getUser(userId)) return false;
  return isAdminOfAgentGroup(userId, agentGroupId) || hasMembershipRow(userId, agentGroupId);
}

/**
 * All agent groups this user can access. Owners and global admins see every
 * group; everyone else sees the union of groups they're scoped-admin of and
 * groups they're a direct member of.
 */
export function listAccessibleAgentGroups(userId: string): AgentGroup[] {
  if (!getUser(userId)) return [];
  if (isOwner(userId) || isGlobalAdmin(userId)) return getAllAgentGroups();

  const ids = new Set<string>();
  for (const role of getUserRoles(userId)) {
    if (role.role === 'admin' && role.agent_group_id) ids.add(role.agent_group_id);
  }
  for (const m of getMembershipsForUser(userId)) {
    ids.add(m.agent_group_id);
  }
  if (ids.size === 0) return [];
  return getAllAgentGroups().filter((g) => ids.has(g.id));
}
