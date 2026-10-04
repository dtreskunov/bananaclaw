import type { Conversation, ConversationTurn } from '../../../shared/conversation';
import type { ConversationSnapshot } from '../../../shared/conversation-protocol';
import { conversationTimeline } from '../../../server/chat/conversation-timeline';

export function presentedConversation(view: Omit<Conversation, 'timeline'>): Conversation {
  return { ...view, timeline: conversationTimeline(view) };
}

export const testTurn: ConversationTurn = {
  id: 'turn-1',
  phase: 'running',
  outcome: 'pending',
  startedAt: '2026-09-29T00:00:00Z',
  endedAt: null,
  inputIds: [],
  outputIds: [],
  activity: [{ ordinal: 0, ts: '1000', text: 'work', timelinePosition: 100 }],
  usage: [],
  metadata: { status: 'provisional', durationMs: null, model: 'model' },
  liveUsage: null,
};
export function testSnapshot(partial: Partial<Conversation> = {}, streamId = 'test-stream'): ConversationSnapshot {
  return {
    kind: 'snapshot',
    protocolVersion: 2,
    streamId,
    revision: 0,
    conversation: presentedConversation({
      threadId: 'thread',
      messages: [],
      turns: [],
      questions: [],
      connection: { connected: true, activeTurnId: null },
      capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
      ...partial,
    }),
  };
}
