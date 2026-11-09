import { getSession } from '../../../db/sessions.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import type { Approval } from '../../../types.js';

export function approvalGroupId(row: Pick<Approval, 'agent_group_id' | 'session_id'>): string | null {
  return row.agent_group_id ?? (row.session_id ? (getSession(row.session_id)?.agent_group_id ?? null) : null);
}

export function canRespondToApproval(userId: string, row: Approval): boolean {
  const scope = approvalGroupId(row);
  return scope === null ? isOwner(userId) || isGlobalAdmin(userId) : hasAdminPrivilege(userId, scope);
}
