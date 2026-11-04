import { log } from '../../../log.js';
import { isSyncSubscription, SYNC_PROTOCOL_VERSION, SYNC_RELOAD_CLOSE_CODE } from '../../shared/sync.js';
import { object } from '../../shared/validation.js';
import { startGlobalSubscription, SyncAuthenticationError } from './global-sync.js';
import { sendConversationFrame } from './conversation-stream.js';
import type { WebSocket } from 'ws';

export function attachSyncSocket(ws: WebSocket, userId: string, sessionHash: string): void {
  const stream = startGlobalSubscription({
    userId,
    sessionHash,
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
