/**
 * Helper to restart all running containers for an agent group.
 *
 * Deferred restarts use durable on_wake controls; explicit immediate
 * restarts stop the container and optionally wake it via its exit callback.
 */
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { countDueMessages } from './db/session-db.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { openInboundDb, writeSessionMessage } from './session-manager.js';
import { writeApprovalNotification } from './modules/approvals/notification.js';

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wakeContainer call on exit. Without it, containers are killed and
 * only come back on the next real user message.
 * Deferred requests instead wait for committed turn completion. Without a
 * wakeMessage, the replacement acknowledges a silent control and stays idle.
 */
export function restartAgentGroupContainers(
  agentGroupId: string, reason: string, wakeMessage?: string, deferUntilSettled = false,
  origin?: { sessionId: string; messageId?: string | null },
): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    if (deferUntilSettled) {
      if (wakeMessage) {
        writeApprovalNotification(session, wakeMessage, {
          afterRestart: true,
          originMessageId: origin?.sessionId === session.id ? origin.messageId : undefined,
        });
      } else {
        writeSessionMessage(agentGroupId, session.id, {
          id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'system',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ action: 'restart', reason }),
          onWake: 1,
        });
      }
      continue;
    }
    if (wakeMessage) {
      // Stamp the session's own channel routing rather than the agent group's
      // id. The latter is never one of the agent's destinations, so it renders
      // as `from="unknown:agent:<self>"` — which the agent may treat as a
      // spoofed sender, and any reply addressed back at it is undeliverable.
      const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: mg?.platform_id ?? agentGroupId,
        channelType: mg?.channel_type ?? 'agent',
        threadId: mg ? session.thread_id : null,
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
    log.info(deferUntilSettled ? 'Scheduled agent group restarts' : 'Restarting agent group containers', {
      agentGroupId, reason, count: sessions.length,
    });
  }
  return sessions.length;
}
