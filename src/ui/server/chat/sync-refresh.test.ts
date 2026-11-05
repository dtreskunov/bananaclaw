import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Conversation } from '../../shared/conversation.js';
import { SYNC_PROTOCOL_VERSION, type SyncFrame } from '../../shared/sync.js';
import { publishHostChange } from '../../../host-changes.js';

const state = vi.hoisted(() => ({ view: null as Conversation | null }));
vi.mock('../db.js', () => ({
  lookupSessionByHash: () => ({ userId: 'viewer', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
}));
vi.mock('../../../db/sessions.js', () => ({ getSession: () => ({ agent_group_id: 'g' }) }));
vi.mock('./sync-state.js', () => ({
  createGlobalProjection: () => ({
    read: async () => ({ agentActivity: [], approvals: [], attention: [], group: null }),
    canPublish: () => true,
  }),
}));
vi.mock('./conversation-context.js', () => ({ resolveTurnContext: () => ({ sessionId: 's' }) }));
vi.mock('./conversation.js', () => ({ readConversation: () => state.view }));
vi.mock('../../../thread-summaries.js', () => ({ reconcileThreadSummaries: () => {} }));
vi.mock('../../../modules/permissions/access.js', () => ({ canAccessAgentGroup: () => ({ allowed: true }) }));
import { attachSyncSocket } from './sync-socket.js';

afterEach(() => vi.useRealTimers());

it('keeps a pending output delta and its stream revision across a metadata refresh', async () => {
  vi.useFakeTimers();
  state.view = {
    threadId: 'thread',
    messages: [],
    turns: [],
    interactions: [],
    timeline: [],
    connection: { connected: true, activeTurnId: null },
    capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
  };
  const frames: SyncFrame[] = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: (value: string) => frames.push(JSON.parse(value)),
    close: vi.fn(),
  });
  const subscribe = (subscriptionId: number) =>
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          kind: 'subscribe',
          protocolVersion: SYNC_PROTOCOL_VERSION,
          subscriptionId,
          groupId: 'g',
          conversation: { threadId: 'thread', channelType: 'web', messagingGroupId: 'mg' },
          globalCursor: null,
        }),
      ),
      false,
    );
  try {
    attachSyncSocket(ws as unknown as WebSocket, 'viewer', 'hash');
    subscribe(1);
    const initial = frames[0].conversation!;
    state.view = {
      ...state.view,
      messages: [{ id: 'reply', direction: 'out', timestamp: 'now', text: 'New output' }],
      timeline: [{ kind: 'message', messageId: 'reply' }],
    };
    publishHostChange({ kind: 'sessions', sessionId: 's' });
    await vi.advanceTimersByTimeAsync(0);
    subscribe(2);
    await vi.advanceTimersByTimeAsync(100);
    const conversationFrames = frames.filter((frame) => frame.conversation);
    expect(conversationFrames.map((frame) => frame.conversation?.kind)).toEqual(['snapshot', 'update']);
    expect(conversationFrames[1]).toMatchObject({
      subscriptionId: 2,
      conversation: { streamId: initial.streamId, baseRevision: 0, revision: 1 },
    });
    expect(frames.at(-1)).toMatchObject({
      subscriptionId: 2,
      global: { kind: 'snapshot', data: { agentActivity: [], approvals: [], attention: [], group: null } },
    });
  } finally {
    ws.emit('close');
  }
});
