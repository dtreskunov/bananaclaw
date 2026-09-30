import { describe, expect, it } from 'vitest';
import type { Conversation } from './conversation.js';
import {
  diffConversation,
  parseConversationFrame,
  reduceConversation,
  type ConversationSnapshot,
  type ConversationUpdate,
} from './conversation-protocol.js';

const empty: Conversation = {
  threadId: 't',
  messages: [],
  turns: [],
  questions: [],
  connection: { connected: false, activeTurnId: null },
  capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
};
const snapshot: ConversationSnapshot = {
  kind: 'snapshot',
  protocolVersion: 1,
  streamId: 's',
  revision: 0,
  conversation: empty,
};
const next: Conversation = {
  ...empty,
  messages: [
    { id: 'one', direction: 'in', text: 'input', timestamp: 'now', inputState: { messageId: 'one', status: 'queued' } },
    { id: 'two', direction: 'out', text: 'output', timestamp: 'later' },
  ],
};
const update: ConversationUpdate = {
  kind: 'update',
  protocolVersion: 1,
  streamId: 's',
  baseRevision: 0,
  revision: 1,
  changes: diffConversation(empty, next),
};
describe('conversation protocol', () => {
  it('produces identical initial and incremental state', () => {
    const incremental = reduceConversation(snapshot, parseConversationFrame(JSON.parse(JSON.stringify(update))));
    expect(incremental.conversation).toEqual(next);
    expect(reduceConversation(null, { ...snapshot, conversation: next }).conversation).toEqual(next);
  });
  it('ignores duplicates without mutating the prior view', () => {
    const state = reduceConversation(snapshot, update);
    expect(reduceConversation(state, update)).toBe(state);
    expect(snapshot.conversation.messages).toEqual([]);
  });
  it('requires resync on a revision gap or unknown stream', () => {
    expect(() => reduceConversation(snapshot, { ...update, baseRevision: 2, revision: 3 })).toThrow('revision_gap');
    expect(() => reduceConversation(snapshot, { ...update, streamId: 'unknown' })).toThrow('unknown_stream');
    expect(() => reduceConversation(null, update)).toThrow('unknown_stream');
  });
  it('replaces state on reconnect with a new snapshot', () => {
    expect(reduceConversation(reduceConversation(snapshot, update), { ...snapshot, streamId: 'new' })).toEqual({
      ...snapshot,
      streamId: 'new',
    });
  });
  it('atomically applies removals, replacements and order changes', () => {
    const before = reduceConversation(snapshot, update);
    const after = { ...next, messages: [{ ...next.messages[1], text: 'edited' }] };
    expect(
      reduceConversation(before, {
        ...update,
        baseRevision: 1,
        revision: 2,
        changes: diffConversation(next, after),
      }).conversation,
    ).toEqual(after);
    expect(before.conversation.messages).toHaveLength(2);
  });
  it.each([
    null,
    { kind: 'history' },
    { ...snapshot, protocolVersion: 2 },
    { ...snapshot, revision: -1 },
    { ...snapshot, conversation: { ...empty, messages: [{ ...next.messages[0], text: null }] } },
    { ...snapshot, conversation: { ...empty, turns: [{ id: 'malformed' }] } },
    { ...update, revision: 9 },
  ])('rejects malformed or unsupported frames: %j', (frame) => {
    expect(() => parseConversationFrame(frame)).toThrow();
  });
  it('rejects corrupt entity order atomically', () => {
    expect(() =>
      reduceConversation(snapshot, {
        ...update,
        changes: { ...update.changes, messages: { ...update.changes.messages, order: ['missing'] } },
      }),
    ).toThrow('invalid_frame');
    expect(snapshot.conversation).toEqual(empty);
  });
});
