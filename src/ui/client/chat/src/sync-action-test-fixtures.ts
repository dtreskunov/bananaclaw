import { vi } from 'vitest';
import { runSync, startGlobalSync } from './actions';
import { SYNC_PROTOCOL_VERSION, type SyncResponse } from '../../../shared/sync';
import type { ThreadSummary } from '../../../shared/thread';
import { threads } from './state';
import type { Thread } from './types';
import { attentionTargets } from './attention-state';

export type SyncFixtureData = Partial<Omit<SyncResponse, 'threads'>> & { threads?: Thread[] };

export async function installSyncFixture(
  read = vi.fn<(groupId: string | null) => Promise<SyncFixtureData>>().mockImplementation(async () => ({
    approvals: [],
    attention: attentionTargets.peek() ?? [],
    threads: threads.peek().filter((t): t is ThreadSummary => t.sessionId !== null && t.messagingGroupId !== null),
  })),
) {
  vi.stubGlobal('location', { hash: '', protocol: 'https:', host: 'example.test' });
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const sockets: TestSocket[] = [];
  class TestSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    request: { subscriptionId: number; groupId: string | null } | null = null;
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(encoded: string) {
      if (!this.url.endsWith('/api/sync/ws')) return;
      const scheduled = this.request !== null;
      this.request = JSON.parse(encoded);
      if (scheduled) return;
      queueMicrotask(() => {
        const request = this.request!;
        this.request = null;
        if (this.readyState !== 1) return;
        void read(request.groupId).then(
          (data) => {
            this.receive({
              kind: 'sync',
              protocolVersion: SYNC_PROTOCOL_VERSION,
              subscriptionId: request.subscriptionId,
              groupId: request.groupId,
              data: {
                ...(request.groupId
                  ? {
                      threads: [],
                      groupAccess: true,
                      voiceInput: { backend: 'disabled', ready: false },
                    }
                  : {}),
                ...data,
              },
            });
          },
          () => this.close(),
        );
      });
    }
    receive(frame: unknown) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code: 1006 });
    }
  }
  vi.stubGlobal('WebSocket', TestSocket);
  const dispose = startGlobalSync();
  await runSync();
  read.mockClear();
  return {
    read,
    dispose,
    sockets,
    conversationUrls: () => sockets.filter((s) => !s.url.endsWith('/api/sync/ws')).map((s) => s.url),
  };
}
