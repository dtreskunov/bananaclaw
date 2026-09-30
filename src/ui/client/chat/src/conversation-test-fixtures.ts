import type { Conversation, ConversationTurn } from '../../../shared/conversation';
import type { ConversationSnapshot } from '../../../shared/conversation-protocol';

export const testTurn: ConversationTurn = {
  id: 'turn-1',
  phase: 'running',
  outcome: 'pending',
  startedAt: '2026-09-29T00:00:00Z',
  endedAt: null,
  inputIds: [],
  outputIds: [],
  activity: [{ ordinal: 0, ts: '1000', text: 'work' }],
  usage: [],
  metadata: { status: 'provisional', durationMs: null, model: 'model' },
  liveUsage: null,
};
export function testSnapshot(partial: Partial<Conversation> = {}, streamId = 'test-stream'): ConversationSnapshot {
  return {
    kind: 'snapshot',
    protocolVersion: 1,
    streamId,
    revision: 0,
    conversation: {
      threadId: 'thread',
      messages: [],
      turns: [],
      questions: [],
      connection: { connected: true, activeTurnId: null },
      capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
      ...partial,
    },
  };
}
