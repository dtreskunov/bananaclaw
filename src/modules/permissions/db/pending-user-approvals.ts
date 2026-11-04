/**
 * Pending user-approval CRUD. A row is created when an unrecognized OIDC
 * subject tries to sign in; an admin reviews and either approves
 * (creating the user + oidc_link + optional group membership) or denies.
 *
 * The `approver_message_token` is sha256-stored; the plaintext goes in
 * the approval DM link so the admin can click through without needing a
 * separate cookie session. Status transitions are pending → approved |
 * denied | expired (admin tooling or a sweep).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getDb } from '../../../db/connection.js';
import { log } from '../../../log.js';
import { addMember } from './agent-group-members.js';
import { insertIdentity } from './identities.js';
import { insertOidcLink } from './oidc-links.js';
import { grantRole } from './user-roles.js';
import { createUser } from './users.js';
import { transaction } from '../../../db/transaction.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface PendingUserApproval {
  id: string;
  provider: string;
  sub: string;
  email: string | null;
  display_name: string | null;
  claims_json: string | null;
  approver_user_id: string | null;
  approver_channel_type: string | null;
  approver_platform_id: string | null;
  approver_message_token: string | null;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  resolution_note: string | null;
  granted_agent_group_id: string | null;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Find an existing pending row for (provider, sub) — used to coalesce
 * repeat sign-in attempts before approval. Resolved rows (approved,
 * denied) are excluded; the partial unique index added in migration 024
 * lets resolved rows accumulate for audit while still enforcing one
 * in-flight pending row per subject.
 */
export function findPendingByOidcSub(provider: string, sub: string): PendingUserApproval | undefined {
  return getDb()
    .prepare(`SELECT * FROM pending_user_approvals WHERE provider = ? AND sub = ? AND status = 'pending'`)
    .get(provider, sub) as PendingUserApproval | undefined;
}

export function getPendingApproval(id: string): PendingUserApproval | undefined {
  return getDb().prepare('SELECT * FROM pending_user_approvals WHERE id = ?').get(id) as
    | PendingUserApproval
    | undefined;
}

export function listPendingApprovals(): PendingUserApproval[] {
  return getDb()
    .prepare(`SELECT * FROM pending_user_approvals WHERE status = 'pending' ORDER BY created_at`)
    .all() as PendingUserApproval[];
}

/**
 * Create a new pending row + issue a plaintext approval token (returned
 * once; only the hash is stored). The token is meant for embedding in a
 * DM'd approval link.
 */
export function createPendingApproval(args: {
  provider: string;
  sub: string;
  email: string | null;
  display_name: string | null;
  claims: Record<string, unknown> | null;
}): { row: PendingUserApproval; token: string } {
  const id = `pua-${randomBytes(6).toString('hex')}`;
  const token = randomBytes(24).toString('hex');
  getDb()
    .prepare(
      `INSERT INTO pending_user_approvals
         (id, provider, sub, email, display_name, claims_json, approver_message_token)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.provider,
      args.sub,
      args.email,
      args.display_name,
      args.claims ? JSON.stringify(args.claims) : null,
      sha256Hex(token),
    );
  const row = getPendingApproval(id)!;
  return { row, token };
}

export function setApprover(
  id: string,
  approver: { user_id: string; channel_type: string | null; platform_id: string | null },
): void {
  getDb()
    .prepare(
      `UPDATE pending_user_approvals
       SET approver_user_id = ?, approver_channel_type = ?, approver_platform_id = ?
       WHERE id = ?`,
    )
    .run(approver.user_id, approver.channel_type, approver.platform_id, id);
}

export function verifyApprovalToken(id: string, plaintext: string): boolean {
  const row = getPendingApproval(id);
  if (!row || !row.approver_message_token) return false;
  return row.approver_message_token === sha256Hex(plaintext);
}

export function resolveApproval(args: {
  id: string;
  status: 'approved' | 'denied';
  resolved_by_user_id: string;
  granted_agent_group_id: string | null;
  note: string | null;
}): void {
  getDb()
    .prepare(
      `UPDATE pending_user_approvals
       SET status = ?, resolved_at = datetime('now'),
           resolved_by_user_id = ?, granted_agent_group_id = ?, resolution_note = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(args.status, args.resolved_by_user_id, args.granted_agent_group_id, args.note, args.id);
}

/**
 * Transactional approve: mint the user, link the OIDC subject, seed the
 * `web` identity, optionally provision an agent group (callback-injected
 * to avoid pulling group scaffolding into the DB layer), add membership,
 * and mark the row resolved. Shared by the CLI command and the in-band
 * admin DM approval handler so both paths converge on identical state.
 *
 * The `provisionAgentGroup` callback runs INSIDE the transaction; rolling
 * back leaves no users / identities / oidc_links / group rows behind, but
 * any filesystem side effects the callback performs are not rolled back
 * (callers should perform fs work after the transaction returns).
 */
export interface ApprovePendingUserArgs {
  id: string;
  resolverUserId: string;
  displayName?: string | null;
  note?: string | null;
  /**
   * Optional pre-existing agent group to grant membership to. If omitted
   * and {@link provisionAgentGroup} is provided, the callback decides; if
   * both are omitted the user is created with no group access.
   */
  agentGroupId?: string | null;
  /**
   * Optional callback that creates a per-user agent group (DB rows only —
   * no filesystem). Returns the new agent_group_id. Runs inside the same
   * transaction as user creation so a failure rolls everything back.
   */
  provisionAgentGroup?: (ctx: { userId: string; row: PendingUserApproval }) => string;
  /**
   * Optional callback to run AFTER the transaction commits — typically
   * filesystem initialization for the agent group. Failures here are
   * logged but do not roll back the approve (the row is already resolved).
   */
  postCommit?: (ctx: { userId: string; agentGroupId: string | null; row: PendingUserApproval }) => void;
}

export interface ApprovePendingUserResult {
  userId: string;
  displayName: string;
  agentGroupId: string | null;
  row: PendingUserApproval;
}

export function approvePendingUser(args: ApprovePendingUserArgs): ApprovePendingUserResult {
  const row = getPendingApproval(args.id);
  if (!row) throw new Error(`No pending approval: ${args.id}`);
  if (row.status !== 'pending') throw new Error(`Approval ${args.id} is already ${row.status}`);

  const displayName = args.displayName ?? row.display_name ?? row.email ?? `User ${row.sub.slice(0, 8)}`;
  const userId = randomUUID();
  const now = new Date().toISOString();
  let resolvedAgentGroupId: string | null = args.agentGroupId ?? null;

  const txn = transaction(getDb(), () => {
    createUser({
      id: userId,
      kind: row.provider === 'google' ? 'oidc' : row.provider,
      display_name: displayName,
      created_at: now,
    });
    insertIdentity({ userId, channel: 'web', handle: userId, primary: true });
    insertOidcLink({
      provider: row.provider,
      sub: row.sub,
      user_id: userId,
      email: row.email,
      claims: row.claims_json ? (JSON.parse(row.claims_json) as Record<string, unknown>) : null,
    });

    if (!resolvedAgentGroupId && args.provisionAgentGroup) {
      resolvedAgentGroupId = args.provisionAgentGroup({ userId, row });
    }

    if (resolvedAgentGroupId) {
      // Scoped admin grant first (implicit member), explicit member row for
      // symmetry with the rest of the codebase that treats agent_group_members
      // as the membership source of truth.
      grantRole({
        user_id: userId,
        role: 'admin',
        agent_group_id: resolvedAgentGroupId,
        granted_by: args.resolverUserId,
        granted_at: now,
      });
      addMember({
        user_id: userId,
        agent_group_id: resolvedAgentGroupId,
        added_by: args.resolverUserId,
        added_at: now,
      });
    }

    resolveApproval({
      id: args.id,
      status: 'approved',
      resolved_by_user_id: args.resolverUserId,
      granted_agent_group_id: resolvedAgentGroupId,
      note: args.note ?? null,
    });
  });
  txn();

  log.info('oidc approval approved', {
    id: args.id,
    user_id: userId,
    provider: row.provider,
    sub: row.sub,
    email: row.email,
    granted_agent_group_id: resolvedAgentGroupId,
  });

  if (args.postCommit) {
    try {
      args.postCommit({ userId, agentGroupId: resolvedAgentGroupId, row });
    } catch (err) {
      log.error('oidc approval post-commit hook threw', { id: args.id, err });
    }
  }

  return { userId, displayName, agentGroupId: resolvedAgentGroupId, row };
}

export { randomUUID };
