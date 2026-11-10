import { describe, expect, it } from 'vitest';
import { parsePeerConversationId, peerConversationId } from './peer-conversation.js';

describe('peer conversation addresses', () => {
  it.each(['a2a:turn:peer', 'a2a:a/b?c#d'])('round-trips an exact exchange %s', (threadId) => {
    expect(parsePeerConversationId(peerConversationId('session', threadId))).toEqual({
      sessionId: 'session',
      threadId,
    });
  });
  it.each(['other', '__agent:', '__agent:session', '__agent:session/', '__agent:session/%', '__agent:session/a/b'])(
    'rejects malformed peer addresses: %s',
    (value) => expect(parsePeerConversationId(value)).toBeNull(),
  );
});
