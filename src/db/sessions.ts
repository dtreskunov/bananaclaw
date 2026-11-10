import type { Approval, Session } from '../types.js';
import { USER_APPROVAL_OPTIONS, USER_APPROVAL_TITLE, type NormalizedOption } from '../channels/approval-request.js';
import { getDb, hasTable } from './connection.js';
import { getInteraction } from './interactions.js';
import { assertTimestampFields } from './validate-timestamps.js';
import { recordHostChange, transaction } from './transaction.js';

// ── Sessions ──

export function createSession(session: Session): void {
  assertTimestampFields(session, ['last_active', 'created_at']);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    )
    .run(session);
  recordHostChange({ kind: 'sessions', sessionId: session.id, groupId: session.agent_group_id });
}

export function getSession(id: string): Session | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

export function findSession(messagingGroupId: string, threadId: string | null): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id = ? AND status = ?')
      .get(messagingGroupId, threadId, 'active') as Session | undefined;
  }
  return getDb()
    .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL AND status = ?')
    .get(messagingGroupId, 'active') as Session | undefined;
}

/**
 * Session lookup scoped to a specific agent group. Needed when multiple
 * agents are wired to the same messaging group + thread (fan-out) — the
 * plain `findSession` would return whichever agent's session happened to
 * be first and route to the wrong container.
 */
export function findSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
): Session | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS ? AND thread_id IS ? AND status = 'active'",
    )
    .get(agentGroupId, messagingGroupId, threadId) as Session | undefined;
}

/** Find a shareable active session, never an isolated channel-less peer exchange. */
export function findSessionByAgentGroup(agentGroupId: string): Session | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM sessions WHERE agent_group_id = ? AND status = 'active'
      AND (messaging_group_id IS NOT NULL OR thread_id IS NULL) ORDER BY created_at DESC LIMIT 1`,
    )
    .get(agentGroupId) as Session | undefined;
}

export function getSessionsByAgentGroup(agentGroupId: string): Session[] {
  return getDb().prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all(agentGroupId) as Session[];
}

export function getActiveSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'active'").all() as Session[];
}

export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE container_status IN ('running', 'idle')").all() as Session[];
}

export function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): void {
  assertTimestampFields(updates, ['last_active']);
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
  const session = getSession(id);
  if (session) recordHostChange({ kind: 'sessions', sessionId: id, groupId: session.agent_group_id });
}

export class SessionApprovalCancellationRequiredError extends Error {
  constructor() {
    super('Deleting this thread requires confirmation to cancel its outstanding approvals.');
  }
}

export class SessionApprovalInProgressError extends Error {
  constructor() {
    super('An approval is being processed for this thread. Wait for it to finish before deleting.');
  }
}

// Execution is process-local; keep the session guarded through callbacks and wake.
const executingApprovals = new Map<string, string>();

export function beginApprovalExecution(approval: Approval): boolean {
  if (executingApprovals.has(approval.id)) return false;
  if (approval.session_id) executingApprovals.set(approval.id, approval.session_id);
  return true;
}

export function endApprovalExecution(approvalId: string): void {
  executingApprovals.delete(approvalId);
}

export function isApprovalExecuting(approvalId: string): boolean {
  return executingApprovals.has(approvalId);
}

export function assertGroupApprovalsIdle(groupId: string): void {
  const approvals = getDb()
    .prepare(
      `SELECT id,status FROM interactions WHERE agent_group_id=?
     OR session_id IN (SELECT id FROM sessions WHERE agent_group_id=?)`,
    )
    .all(groupId, groupId) as Pick<Approval, 'id' | 'status'>[];
  if (approvals.some((row) => row.status === 'applying' || isApprovalExecuting(row.id)))
    throw new Error(
      'An approval is being processed for this group. Wait for it to finish before archiving or deleting.',
    );
}

export function deleteSession(id: string, cancelApprovals = false): number {
  if ([...executingApprovals.values()].includes(id)) throw new SessionApprovalInProgressError();
  const db = getDb();
  const session = getSession(id);
  return transaction(db, () => {
    if (db.prepare("SELECT 1 FROM interactions WHERE session_id=? AND status='applying'").get(id))
      throw new SessionApprovalInProgressError();
    const approval = db.prepare("SELECT 1 FROM interactions WHERE session_id = ? AND status='pending' LIMIT 1").get(id);
    if (approval && !cancelApprovals) throw new SessionApprovalCancellationRequiredError();
    const cancelledApprovals = db
      .prepare("DELETE FROM interactions WHERE session_id = ? AND status='pending'")
      .run(id).changes;
    db.prepare('DELETE FROM interactions WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    recordHostChange({ kind: 'interactions', sessionId: id });
    recordHostChange({ kind: 'sessions', sessionId: id, groupId: session?.agent_group_id });
    return cancelledApprovals;
  })();
}

type ApprovalRender = { title: string; options: NormalizedOption[] };

/** Resolve persisted approval options before decoding a channel callback. */
export function getApprovalRender(id: string): ApprovalRender | undefined {
  const record = getInteraction(id);
  if (record?.input.title) return { title: record.input.title, options: record.input.options };

  // Channel-registration + unknown-sender approvals persist title/options_json
  // the same way approvals does — just SELECT and return.
  if (hasTable(getDb(), 'pending_channel_approvals')) {
    const c = getDb()
      .prepare('SELECT title, options_json FROM pending_channel_approvals WHERE messaging_group_id = ?')
      .get(id) as { title: string; options_json: string } | undefined;
    if (c?.title) return { title: c.title, options: JSON.parse(c.options_json) };
  }

  if (hasTable(getDb(), 'pending_sender_approvals')) {
    const s = getDb().prepare('SELECT title, options_json FROM pending_sender_approvals WHERE id = ?').get(id) as
      | { title: string; options_json: string }
      | undefined;
    if (s?.title) return { title: s.title, options: JSON.parse(s.options_json) };
  }

  if (hasTable(getDb(), 'pending_user_approvals')) {
    const user = getDb().prepare('SELECT 1 FROM pending_user_approvals WHERE id = ?').get(id);
    if (user) return { title: USER_APPROVAL_TITLE, options: USER_APPROVAL_OPTIONS };
  }

  return undefined;
}
