/**
 * FK-ordered cascade delete for an agent group.
 *
 * Extracted from `src/cli/resources/groups.ts` so the same transaction can
 * be invoked by both the CLI delete handler and the archive flow. No
 * behavior change vs. the original CLI implementation.
 */
import { getDb, hasTable } from './connection.js';

export interface CascadeCounts {
  sessions: number;
  questions: number;
  pending_approvals: number;
  agent_destinations_owned: number;
  agent_destinations_pointing: number;
  pending_sender_approvals: number;
  pending_channel_approvals: number;
  messaging_group_agents: number;
  agent_group_members: number;
  user_roles: number;
  container_configs: number;
}

/**
 * Delete an agent group and every dependent row in FK order, within a single
 * transaction. Throws if the group doesn't exist (preserves the
 * genericDelete behavior of surfacing unknown ids). Returns counts sourced
 * from each statement's `changes` so the caller sees exactly what the
 * transaction did.
 *
 * Out of scope: killing running containers, on-disk cleanup of
 * `groups/<folder>/` and `data/v2-sessions/<group-id>/`.
 */
export function cascadeDeleteAgentGroup(id: string): CascadeCounts {
  const db = getDb();

  const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
  if (!exists) throw new Error(`group not found: ${id}`);

  const hasAgentDestinations = hasTable(db, 'agent_destinations');
  const hasPendingApprovals = hasTable(db, 'pending_approvals');

  const cascade = db.transaction((groupId: string): CascadeCounts => {
    const counts: CascadeCounts = {
      sessions: 0,
      questions: 0,
      pending_approvals: 0,
      agent_destinations_owned: 0,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 0,
      pending_channel_approvals: 0,
      messaging_group_agents: 0,
      agent_group_members: 0,
      user_roles: 0,
      container_configs: 0,
    };

    if (hasAgentDestinations) {
      counts.agent_destinations_owned = db
        .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
        .run(groupId).changes;
      counts.agent_destinations_pointing = db
        .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
        .run('agent', groupId).changes;
    }
    counts.questions = db
      .prepare('DELETE FROM questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)')
      .run(groupId).changes;
    if (hasPendingApprovals) {
      counts.pending_approvals = db
        .prepare(
          'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
        )
        .run(groupId, groupId).changes;
    }
    counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(groupId).changes;
    counts.pending_sender_approvals = db
      .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
      .run(groupId).changes;
    counts.pending_channel_approvals = db
      .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
      .run(groupId).changes;
    counts.messaging_group_agents = db
      .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
      .run(groupId).changes;
    counts.agent_group_members = db
      .prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?')
      .run(groupId).changes;
    counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(groupId).changes;
    // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
    // the explicit delete here mirrors the other tables and surfaces the count.
    counts.container_configs = db
      .prepare('DELETE FROM container_configs WHERE agent_group_id = ?')
      .run(groupId).changes;
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run(groupId);
    return counts;
  });

  return cascade(id);
}
