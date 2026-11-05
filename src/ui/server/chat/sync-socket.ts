import { log } from '../../../log.js';
import { onHostChange } from '../../../host-changes.js';
import { getSession } from '../../../db/sessions.js';
import {
  isSyncSubscription,
  SYNC_PROTOCOL_VERSION,
  SYNC_RELOAD_CLOSE_CODE,
  type SyncSubscription,
} from '../../shared/sync.js';
import { object } from '../../shared/validation.js';
import { lookupSessionByHash } from '../db.js';
import { createGlobalProjection } from './sync-state.js';
import { startSyncStream, sendSyncFrame } from './sync-stream.js';
import { readConversation } from './conversation.js';
import { resolveTurnContext } from './conversation-context.js';
import { startConversationStream } from './conversation-stream.js';
import type { WebSocket } from 'ws';

export function attachSyncSocket(ws: WebSocket, userId: string, sessionHash: string): void {
  let selection: SyncSubscription | null = null;
  let invalidateGlobal: (groupId?: string, refreshThreads?: boolean) => void = () => {};
  let invalidateConversation = () => {};
  let stopConversation = () => {};
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(subscriptionTimer);
    clearTimeout(authTimer);
    off();
    global.stop();
    stopConversation();
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    log.error('Synchronization failed', { userId, err: error });
    ws.close(1011, 'Synchronization unavailable; reconnect or reload');
    stop();
  };
  const authorize = () => {
    const session = lookupSessionByHash(sessionHash, { touch: false });
    const deadline = Date.parse(session?.expiresAt ?? '');
    if (!session || session.userId !== userId || !Number.isFinite(deadline)) {
      ws.close(4401, 'Authentication expired');
      stop();
      throw new Error('Synchronization authentication expired');
    }
    clearTimeout(authTimer);
    authTimer = setTimeout(
      () => {
        try {
          authorize();
        } catch (error) {
          fail(error);
        }
      },
      Math.min(2_147_483_647, Math.max(1, deadline - Date.now())),
    );
    authTimer.unref();
  };
  const projection = createGlobalProjection(userId);
  const global = startSyncStream({
    ...projection,
    authorize,
    subscribe: (invalidate) => {
      invalidateGlobal = invalidate;
      return () => {};
    },
    send: (frame) =>
      sendSyncFrame(ws, {
        ...frame,
        ...(!selection?.conversation ? { conversation: null } : {}),
      }),
    fail,
  });
  const off = onHostChange((change) => {
    if (change.kind === 'configuration') invalidateGlobal(change.groupId ?? undefined, false);
    else if (change.kind === 'sessions') {
      const groupId = change.groupId ?? (change.sessionId ? getSession(change.sessionId)?.agent_group_id : undefined);
      invalidateGlobal(undefined, false);
      invalidateGlobal(groupId ?? undefined);
    } else if (change.kind !== 'activity') invalidateGlobal(undefined, change.kind === 'access');
    if (!selection?.conversation || !selection.groupId) return;
    if ('groupId' in change && change.groupId && change.groupId !== selection.groupId) return;
    if (change.kind === 'interactions' && change.sessionId === null) return;
    const context = resolveTurnContext(
      userId,
      selection.groupId,
      selection.conversation.threadId,
      selection.conversation.messagingGroupId
        ? {
            channelType: selection.conversation.channelType,
            messagingGroupId: selection.conversation.messagingGroupId,
          }
        : undefined,
    );
    if (!context?.sessionId || !('sessionId' in change) || !change.sessionId || change.sessionId === context.sessionId)
      invalidateConversation();
  });
  const subscriptionTimer = setTimeout(() => {
    ws.close(1008, 'Sync subscription timed out');
    stop();
  }, 10_000);
  subscriptionTimer.unref();
  ws.on('message', (raw, binary) => {
    if (stopped) return;
    try {
      if (binary) throw new Error('Sync messages must be JSON');
      const message: unknown = JSON.parse(raw.toString());
      if (object(message) && message.protocolVersion !== SYNC_PROTOCOL_VERSION) {
        log.warn('Synchronization protocol version rejected', { userId });
        ws.send(JSON.stringify({ kind: 'protocol_mismatch', protocolVersion: SYNC_PROTOCOL_VERSION }));
        ws.close(SYNC_RELOAD_CLOSE_CODE, 'Synchronization protocol changed; reload');
        stop();
        return;
      }
      if (!isSyncSubscription(message)) throw new Error('Invalid sync subscription');
      clearTimeout(subscriptionTimer);
      if (selection && message.subscriptionId <= selection.subscriptionId) return;
      authorize();
      const refreshThreads =
        !selection ||
        selection.groupId !== message.groupId ||
        JSON.stringify(selection.conversation) === JSON.stringify(message.conversation);
      stopConversation();
      invalidateConversation = () => {};
      selection = message;
      global.subscribe(message.subscriptionId, message.groupId, refreshThreads);
      const { groupId, conversation } = message;
      if (groupId && conversation) {
        const override = conversation.messagingGroupId
          ? { channelType: conversation.channelType, messagingGroupId: conversation.messagingGroupId }
          : undefined;
        stopConversation = startConversationStream({
          read: () => {
            authorize();
            return resolveTurnContext(userId, groupId, conversation.threadId, override)
              ? readConversation(userId, groupId, conversation.threadId, override)
              : null;
          },
          subscribe: (invalidate) => {
            invalidateConversation = invalidate;
            return () => {};
          },
          send: (frame) => {
            if (selection !== message || stopped) return;
            sendSyncFrame(ws, {
              kind: 'sync',
              protocolVersion: SYNC_PROTOCOL_VERSION,
              subscriptionId: message.subscriptionId,
              groupId,
              conversation: frame,
            });
          },
          fail,
        });
      }
    } catch (error) {
      if (stopped) return;
      log.warn('Invalid synchronization request', { userId, err: error });
      ws.close(1008, 'Invalid sync subscription');
      stop();
    }
  });
  ws.on('close', stop);
  ws.on('error', (error) => {
    log.warn('Synchronization socket error', { userId, err: error });
    stop();
  });
}
