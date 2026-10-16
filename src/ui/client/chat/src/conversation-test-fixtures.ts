import type { Conversation, ConversationTurn } from '../../../shared/conversation';
import { CONVERSATION_PROTOCOL_VERSION, type ConversationSnapshot } from '../../../shared/conversation-protocol';
import { conversationTimeline } from '../../../server/chat/conversation-timeline';
import type { PendingWebSend } from './types';

export const testWebSubmission: PendingWebSend = {
  groupId: 'group',
  threadId: 'thread',
  messageId: 'web-client-123',
  clientMessageId: 'client-123',
  text: 'Hello',
  files: [],
  timestamp: '2026-09-29T00:00:00Z',
  startsResponse: true,
  status: 'sending',
};

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
};
export function testSnapshot(partial: Partial<Conversation> = {}, streamId = 'test-stream'): ConversationSnapshot {
  return {
    kind: 'snapshot',
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
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
