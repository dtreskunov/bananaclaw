import { getAgentGroup } from '../../../db/agent-groups.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import type { GlobalSyncState } from '../../shared/sync.js';
import { readInteractionSync } from './attention.js';
import { listThreadsForViewer, withThreadAttention, readAgentActivity } from './threads.js';
import { resolveVoiceInputConfig } from './voice-input-config.js';
import { hostAccessRevision } from '../../../host-changes.js';

export function createGlobalProjection(userId: string) {
  let authorizedAt = -1;
  return {
    canPublish: () => authorizedAt === hostAccessRevision(),
    async read(groupId: string | null): Promise<GlobalSyncState> {
      const version = hostAccessRevision();
      let group: GlobalSyncState['group'] = null;
      if (groupId && getAgentGroup(groupId) && canAccessAgentGroup(userId, groupId).allowed) {
        const threads = await listThreadsForViewer(userId, groupId, []);
        if (getAgentGroup(groupId) && canAccessAgentGroup(userId, groupId).allowed)
          group = { threads, voiceInput: resolveVoiceInputConfig(groupId) };
      }
      const interactions = readInteractionSync(userId);
      if (group && groupId)
        group = { ...group, threads: withThreadAttention(groupId, group.threads, interactions.attention) };
      const agentActivity = readAgentActivity(userId, interactions.attention, groupId, group?.threads ?? []);
      authorizedAt = version;
      return { ...interactions, agentActivity, group };
    },
  };
}

export async function readGlobalSync(userId: string, groupId: string | null): Promise<GlobalSyncState> {
  return createGlobalProjection(userId).read(groupId);
}
