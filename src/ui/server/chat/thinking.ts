import { getContainerConfig } from '../../../db/container-configs.js';
import { defaultProvider, resolveDefaultEffort, resolveDefaultModel } from '../../../env.js';
import { defaultThinkingLevel, thinkingLevels } from '../../shared/thinking-levels.js';

export function conversationThinking(groupId: string): { levels: readonly string[]; defaultLevel: string | null } {
  const config = getContainerConfig(groupId);
  const provider = config?.provider ?? defaultProvider();
  const model = config?.model ?? resolveDefaultModel(provider) ?? null;
  return {
    levels: thinkingLevels(provider, model),
    defaultLevel: config?.effort ?? resolveDefaultEffort() ?? defaultThinkingLevel(provider, model),
  };
}
