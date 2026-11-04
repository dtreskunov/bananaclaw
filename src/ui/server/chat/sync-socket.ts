import fs from 'node:fs';
import { getSession } from '../../../db/sessions.js';
import { onConversationChange } from '../../../conversation-events.js';
import { onUiChange, invalidateUi } from '../../../ui-events.js';
import { log } from '../../../log.js';
import { isSyncSubscription, SYNC_PROTOCOL_VERSION, SYNC_RELOAD_CLOSE_CODE } from '../../shared/sync.js';
import { object } from '../../shared/validation.js';
import { lookupSessionByHash } from '../db.js';
import { readGlobalSync, nextSyncDeadline } from './sync-state.js';
import { startSyncStream } from './sync-stream.js';
import { sendConversationFrame } from './conversation-stream.js';
import type { WebSocket } from 'ws';
import type { ThreadSummary } from '../../shared/thread.js';

let configWatcher: fs.FSWatcher | undefined;
let configSubscribers = 0;
class SyncAuthenticationError extends Error {}
function watchConfiguration(): () => void {
  if (configSubscribers++ === 0) {
    configWatcher = fs.watch(process.cwd(), { persistent: false }, (_event, filename) => {
      if (filename === null || filename === '.env') invalidateUi({ kind: 'access' });
    });
    configWatcher.on('error', (error) => log.error('Live UI configuration watcher failed', { err: error }));
  }
  return () => {
    if (--configSubscribers === 0) {
      configWatcher?.close();
      configWatcher = undefined;
    }
  };
}

export function attachSyncSocket(
  ws: WebSocket,
  userId: string,
  sessionHash: string,
  listThreads: (userId: string, groupId: string) => Promise<ThreadSummary[]>,
): void {
  const stream = startSyncStream({
    read: (groupId) => readGlobalSync(userId, groupId, listThreads),
    authorize: () => {
      const session = lookupSessionByHash(sessionHash, { touch: false });
      if (!session || session.userId !== userId)
        throw new SyncAuthenticationError('Global sync authentication expired');
    },
    subscribe: (invalidate) => {
      const offConfiguration = watchConfiguration();
      const offUi = onUiChange((change) => {
        if (change.kind === 'access') {
          invalidate();
        } else if (change.kind === 'group') invalidate(change.groupId);
        else invalidate();
      });
      const offConversation = onConversationChange((sessionId) => {
        if (sessionId === null) invalidate();
        else {
          const session = getSession(sessionId);
          if (session) invalidate(session.agent_group_id);
        }
      });
      return () => {
        offConfiguration();
        offUi();
        offConversation();
      };
    },
    deadline: () => nextSyncDeadline(sessionHash),
    send: (frame) => sendConversationFrame(ws, frame),
    fail: (error) => {
      log.error('Global synchronization failed', { userId, err: error });
      ws.close(
        error instanceof SyncAuthenticationError ? 4401 : 1011,
        error instanceof SyncAuthenticationError
          ? 'Authentication expired'
          : 'Global synchronization unavailable; reconnect or reload',
      );
    },
  });
  const subscriptionTimer = setTimeout(() => {
    stream.stop();
    ws.close(1008, 'Sync subscription timed out');
  }, 10_000);
  subscriptionTimer.unref();
  ws.on('message', (raw, binary) => {
    try {
      if (binary) throw new Error('Sync messages must be JSON');
      const message: unknown = JSON.parse(raw.toString());
      if (object(message) && message.protocolVersion !== SYNC_PROTOCOL_VERSION) {
        log.warn('Global sync protocol version rejected', { userId });
        ws.send(JSON.stringify({ kind: 'protocol_mismatch', protocolVersion: SYNC_PROTOCOL_VERSION }));
        ws.close(SYNC_RELOAD_CLOSE_CODE, 'Global sync protocol changed; reload');
        stream.stop();
        return;
      }
      if (!isSyncSubscription(message)) throw new Error('Invalid sync subscription');
      clearTimeout(subscriptionTimer);
      stream.subscribe(message.subscriptionId, message.groupId);
    } catch (error) {
      log.warn('Invalid global sync request', { userId, err: error });
      ws.close(1008, 'Invalid sync subscription');
      stream.stop();
    }
  });
  ws.on('close', () => {
    clearTimeout(subscriptionTimer);
    stream.stop();
  });
  ws.on('error', (error) => {
    log.warn('Global sync socket error', { userId, err: error });
    clearTimeout(subscriptionTimer);
    stream.stop();
  });
}
