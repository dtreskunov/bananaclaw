import { getContainerConfig } from '../../../db/container-configs.js';
import { defaultProvider, resolveDefaultEffort, resolveDefaultModel } from '../../../env.js';
import { thinkingLevels } from '../../shared/thinking-levels.js';

export function conversationThinking(groupId: string): { levels: readonly string[]; defaultLevel: string | null } {
  const config = getContainerConfig(groupId);
  const provider = config?.provider ?? defaultProvider();
  return {
    levels: thinkingLevels(provider, config?.model ?? resolveDefaultModel(provider) ?? null),
    defaultLevel: config?.effort ?? resolveDefaultEffort() ?? null,
  };
}
