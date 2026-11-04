import { getAgentGroup } from '../../../db/agent-groups.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import type { GlobalSyncState } from '../../shared/sync.js';
import type { ThreadSummary } from '../../shared/thread.js';
import { readInteractionSync } from './attention.js';
import { listThreadsForViewer } from './threads.js';
import { resolveVoiceInputConfig } from './voice-input-config.js';
import { hostAccessRevision } from '../../../host-changes.js';

export function createGlobalProjection(userId: string) {
  let threads: ThreadSummary[] = [];
  let scope: string | null | undefined;
  let authorizedAt = -1;
  return {
    canPublish: () => authorizedAt === hostAccessRevision(),
    async read(groupId: string | null, refreshThreads: boolean): Promise<GlobalSyncState> {
      const version = hostAccessRevision();
      let group: GlobalSyncState['group'] = null;
      if (groupId && getAgentGroup(groupId) && canAccessAgentGroup(userId, groupId).allowed) {
        if (refreshThreads || scope !== groupId || authorizedAt !== version)
          threads = await listThreadsForViewer(userId, groupId);
        if (getAgentGroup(groupId) && canAccessAgentGroup(userId, groupId).allowed)
          group = { threads, voiceInput: resolveVoiceInputConfig(groupId) };
      }
      scope = groupId;
      authorizedAt = version;
      return { ...readInteractionSync(userId), group };
    },
  };
}

export async function readGlobalSync(userId: string, groupId: string | null): Promise<GlobalSyncState> {
  return createGlobalProjection(userId).read(groupId, true);
}
