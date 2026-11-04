import { getAgentGroup } from '../../../db/agent-groups.js';
import { getDb } from '../../../db/connection.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import type { GlobalSyncState } from '../../shared/sync.js';
import { readInteractionSync } from './attention.js';
import type { ThreadSummary } from '../../shared/thread.js';
import { resolveVoiceInputConfig } from './voice-input-config.js';

export async function readGlobalSync(
  userId: string,
  groupId: string | null,
  listThreads: (userId: string, groupId: string) => Promise<ThreadSummary[]>,
): Promise<GlobalSyncState> {
  const data: GlobalSyncState = { ...readInteractionSync(userId), group: null };
  if (!groupId) return data;
  const accessible = () => !!getAgentGroup(groupId) && canAccessAgentGroup(userId, groupId).allowed;
  const denied = () => ({
    ...readInteractionSync(userId),
    group: null,
  });
  if (!accessible()) return denied();
  const threads = await listThreads(userId, groupId);
  if (!accessible()) return denied();
  return {
    ...readInteractionSync(userId),
    group: { threads, voiceInput: resolveVoiceInputConfig(groupId) },
  };
}

export function nextSyncDeadline(sessionHash: string): number | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare(
      `SELECT MIN(expires_at) AS deadline FROM (
       SELECT expires_at FROM ui_sessions WHERE token_hash = ?
       UNION ALL
       SELECT expires_at FROM interactions WHERE status='pending' AND expires_at > ?
     )`,
    )
    .get(sessionHash, now) as { deadline: string | null };
  if (row.deadline === null) return null;
  const deadline = Date.parse(row.deadline);
  if (!Number.isFinite(deadline)) throw new Error('Invalid synchronization expiry deadline');
  return deadline;
}
