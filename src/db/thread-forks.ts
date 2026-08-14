import { getDb } from './connection.js';

export interface ThreadFork {
  agent_group_id: string;
  messaging_group_id: string;
  thread_id: string;
  parent_thread_id: string;
  parent_message_id: string;
  /**
   * Timestamp of the anchor message, i.e. the cut point. The branch holds a
   * copy of every parent message at or before this instant, which is what lets
   * a delete work out how much of the parent survives elsewhere.
   */
  parent_message_ts: string;
  parent_title: string | null;
  fidelity: 'native' | 'transcript';
  created_at: string;
}

export function createThreadFork(row: ThreadFork): void {
  getDb()
    .prepare(
      `INSERT INTO thread_forks
         (agent_group_id, messaging_group_id, thread_id, parent_thread_id, parent_message_id,
          parent_message_ts, parent_title, fidelity, created_at)
       VALUES
         (@agent_group_id, @messaging_group_id, @thread_id, @parent_thread_id, @parent_message_id,
          @parent_message_ts, @parent_title, @fidelity, @created_at)`,
    )
    .run(row);
}

export function getThreadFork(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string,
): ThreadFork | undefined {
  return getDb()
    .prepare('SELECT * FROM thread_forks WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ?')
    .get(agentGroupId, messagingGroupId, threadId) as ThreadFork | undefined;
}

/** Every fork whose parent is `threadId`, oldest first. */
export function getThreadForkChildren(
  agentGroupId: string,
  messagingGroupId: string,
  parentThreadId: string,
): ThreadFork[] {
  return getDb()
    .prepare(
      `SELECT * FROM thread_forks
        WHERE agent_group_id = ? AND messaging_group_id = ? AND parent_thread_id = ?
        ORDER BY created_at`,
    )
    .all(agentGroupId, messagingGroupId, parentThreadId) as ThreadFork[];
}

/** All lineage rows for an agent group's messaging group. Used to build the rail tree. */
export function getThreadForks(agentGroupId: string, messagingGroupId: string): ThreadFork[] {
  return getDb()
    .prepare('SELECT * FROM thread_forks WHERE agent_group_id = ? AND messaging_group_id = ?')
    .all(agentGroupId, messagingGroupId) as ThreadFork[];
}

/** All lineage rows for an agent group, across every messaging group. */
export function getThreadForksForAgentGroup(agentGroupId: string): ThreadFork[] {
  return getDb().prepare('SELECT * FROM thread_forks WHERE agent_group_id = ?').all(agentGroupId) as ThreadFork[];
}

/**
 * Drop a thread's own lineage row. Rows naming it as *parent* are deliberately
 * left behind so surviving forks can still render their (now dead) origin.
 */
export function deleteThreadFork(agentGroupId: string, messagingGroupId: string, threadId: string): void {
  getDb()
    .prepare('DELETE FROM thread_forks WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ?')
    .run(agentGroupId, messagingGroupId, threadId);
}

/** Recursive descendants of a thread, breadth-first. Used by cascading delete. */
export function getThreadForkDescendants(
  agentGroupId: string,
  messagingGroupId: string,
  rootThreadId: string,
): ThreadFork[] {
  const out: ThreadFork[] = [];
  const seen = new Set<string>([rootThreadId]);
  const queue = [rootThreadId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of getThreadForkChildren(agentGroupId, messagingGroupId, current)) {
      if (seen.has(child.thread_id)) continue;
      seen.add(child.thread_id);
      out.push(child);
      queue.push(child.thread_id);
    }
  }
  return out;
}
