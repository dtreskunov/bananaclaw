import { afterEach, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
import { runSync, startGlobalSync } from './actions';
import { attentionError, attentionTargets } from './attention-state';
import { activeTurn, channelType, chatReady, groupId, messagingGroupId, threadId, threads } from './state';
import { applyTurnState } from './stop-turn';
import { testThread } from './conversation-test-fixtures';
import { SYNC_PROTOCOL_VERSION } from '../../../shared/sync';

let dispose = () => {};
afterEach(() => {
  dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('pushes metadata and resolves refreshes without HTTP polling or overwriting a non-web conversation', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('location', { protocol: 'https:', host: 'chat.example' });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected HTTP polling');
    }),
  );
  const sockets: Socket[] = [];
  class Socket {
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    send = vi.fn((_value: string) => {});
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
    constructor(readonly url: string) {
      sockets.push(this);
    }
  }
  vi.stubGlobal('WebSocket', Socket);
  groupId.value = 'g';
  threadId.value = 'external';
  channelType.value = 'telegram';
  messagingGroupId.value = 'telegram-mg';
  chatReady.value = true;
  applyTurnState({ id: 'live-turn', status: 'running' }, true);
  threads.value = [testThread({ threadId: 'blank', sessionId: null, title: '(new thread)', messageCount: 0 })];
  dispose = startGlobalSync();
  expect(sockets[0].url).toBe('wss://chat.example/ui/chat/api/sync/ws');
  sockets[0].readyState = 1;
  sockets[0].onopen?.();
  const refreshed = runSync();
  const secondRefresh = runSync();
  const subscription = JSON.parse(sockets[0].send.mock.calls.at(-1)![0]);
  const data = {
    approvals: [],
    attention: [],
    threads: [testThread()],
    groupAccess: true,
    voiceInput: { backend: 'disabled', ready: false },
  };
  sockets[0].onmessage?.({
    data: JSON.stringify({
      kind: 'sync',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      subscriptionId: subscription.subscriptionId,
      groupId: 'g',
      data,
    }),
  });
  expect(await refreshed).toBe(true);
  expect(await secondRefresh).toBe(true);
  expect(threads.value.map((row) => row.threadId)).toEqual(['blank', 'thread']);
  expect(attentionTargets.value).toEqual([]);
  expect(activeTurn.value?.id).toBe('live-turn');
  expect(chatReady.value).toBe(true);
  const sent = sockets[0].send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sockets[0].send).toHaveBeenCalledTimes(sent);
  expect(fetch).not.toHaveBeenCalled();
  sockets[0].close();
  expect(attentionError.value).toContain('disconnected');
  expect(threads.value).toHaveLength(2);
  expect(chatReady.value).toBe(true);
});
