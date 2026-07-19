/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { countDueMessages } from './db/session-db.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { openInboundDb, writeSessionMessage } from './session-manager.js';

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wakeContainer call on exit. Without it, containers are killed and
 * only come back on the next real user message.
 */
export function restartAgentGroupContainers(agentGroupId: string, reason: string, wakeMessage?: string): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    if (wakeMessage) {
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: wakeMessage,
          sender: 'system',
          senderId: 'system',
        }),
        onWake: 1,
      });
    }
    // Always respawn after the kill when there is anything to process: an
    // explicit wake message, or in-flight messages the dying container had
    // claimed. Without this, a provider switch mid-conversation leaves the
    // claimed messages dark until the next inbound or a slow sweep backoff.
    const hasPending = countDueMessages(openInboundDb(session.agent_group_id, session.id)) > 0;
    killContainer(
      session.id,
      reason,
      wakeMessage || hasPending
        ? () => {
            const s = getSession(session.id);
            if (!s) return;
            const messagingGroup = s.messaging_group_id ? getMessagingGroup(s.messaging_group_id) : undefined;
            if (messagingGroup) {
              startTypingRefresh(
                s.id,
                s.agent_group_id,
                messagingGroup.channel_type,
                messagingGroup.platform_id,
                s.thread_id,
                messagingGroup.instance,
              );
            }
            void wakeContainer(s).then((woke) => {
              if (!woke && messagingGroup) stopTypingRefresh(s.id);
            });
          }
        : undefined,
    );
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
  }
  return sessions.length;
}
