import { describe, expect, it } from 'vitest';
import { isTurnUsageAdvisory, type Conversation } from './conversation.js';
import {
  CONVERSATION_PROTOCOL_VERSION,
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
  interactions: [],
  timeline: [],
  connection: { connected: false, activeTurnId: null },
  capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
};
const snapshot: ConversationSnapshot = {
  kind: 'snapshot',
  protocolVersion: CONVERSATION_PROTOCOL_VERSION,
  streamId: 's',
  revision: 0,
  conversation: empty,
};
const next: Conversation = {
  ...empty,
  messages: [
    {
      id: 'one',
      direction: 'in',
      text: 'input',
      timestamp: 1767225600000,
      inputState: { messageId: 'one', status: 'queued' },
    },
    { id: 'two', direction: 'out', text: 'output', timestamp: 1767225601000 },
  ],
  timeline: [
    { kind: 'message', messageId: 'one' },
    { kind: 'message', messageId: 'two' },
  ],
};
const update: ConversationUpdate = {
  kind: 'update',
  protocolVersion: CONVERSATION_PROTOCOL_VERSION,
  streamId: 's',
  baseRevision: 0,
  revision: 1,
  changes: diffConversation(empty, next),
};
describe('conversation protocol', () => {
  it('round-trips optional thinking capabilities and durable message levels through snapshots and patches', () => {
    const view: Conversation = {
      ...next,
      capabilities: { ...empty.capabilities, thinking: { levels: ['low', 'high'], defaultLevel: 'low' } },
      messages: next.messages.map((message) =>
        message.direction === 'in' ? { ...message, thinkingLevel: 'high' } : message,
      ),
    };
    const changes = diffConversation(empty, view);
    const patched = reduceConversation(snapshot, parseConversationFrame({ ...update, changes }));
    expect(patched.conversation).toEqual(view);
    expect(parseConversationFrame({ ...snapshot, conversation: view })).toMatchObject({ conversation: view });
    expect(() =>
      parseConversationFrame({
        ...snapshot,
        conversation: {
          ...view,
          messages: [{ ...view.messages[0], thinkingLevel: 'invalid' }],
        },
      }),
    ).toThrow('invalid_frame');
  });

  it('shares strict advisory validation with the host without accepting impossible lifecycle states', () => {
    const queued = {
      threshold: 10,
      reportedTokens: 10,
      triggeredAt: 0,
      status: 'queued',
      appliedAt: null,
      finishedAt: null,
    };
    expect(isTurnUsageAdvisory(queued)).toBe(true);
    expect(isTurnUsageAdvisory({ ...queued, status: 'applied', appliedAt: 1 })).toBe(true);
    expect(isTurnUsageAdvisory({ ...queued, status: 'skipped', finishedAt: 1 })).toBe(true);
    for (const fields of [
      { threshold: 0 },
      { threshold: 1.5 },
      { reportedTokens: 9 },
      { reportedTokens: '10' },
      { triggeredAt: -1 },
      { status: 'applied' },
      { status: 'skipped' },
      { status: 'other' },
      { appliedAt: 1 },
      { finishedAt: 1 },
      { extra: true },
      { status: 'applied', appliedAt: 1, finishedAt: 1 },
    ])
      expect(isTurnUsageAdvisory({ ...queued, ...fields })).toBe(false);
  });
  it('rejects ambiguous or malformed sender and recipient identities', () => {
    const frame = (fields: object) => ({
      ...snapshot,
      conversation: {
        ...empty,
        messages: [{ ...next.messages[0], ...fields }],
        timeline: [{ kind: 'message', messageId: 'one' }],
      },
    });
    for (const author of [
      { displayName: 'Missing identity' },
      { userId: 'user', agentGroupId: 'agent', displayName: 'Ambiguous' },
      { agentGroupId: '', displayName: 'Empty' },
    ])
      expect(() => parseConversationFrame(frame({ author }))).toThrow('invalid_frame');
    expect(() => parseConversationFrame(frame({ recipient: { displayName: 'Missing identity' } }))).toThrow(
      'invalid_frame',
    );
  });
  it('accepts epoch zero and rejects string or imprecise timestamps before reducing snapshots', () => {
    const frame = {
      ...snapshot,
      conversation: {
        ...empty,
        messages: [{ ...next.messages[0], timestamp: 0 }],
        timeline: [{ kind: 'message', messageId: 'one' }],
      },
    };
    expect(reduceConversation(null, parseConversationFrame(frame)).conversation.messages[0].timestamp).toBe(0);
    for (const timestamp of ['2026-01-01T00:00:00Z', '0', 0.5, Infinity, 8640000000000001]) {
      expect(() =>
        parseConversationFrame({
          ...frame,
          conversation: { ...frame.conversation, messages: [{ ...next.messages[0], timestamp }] },
        }),
      ).toThrow('invalid_frame');
    }
    expect(() => parseConversationFrame({ ...frame, protocolVersion: 15 })).toThrow('Reload');
  });

  it('patches and clears opaque rendered-content cursors without replacing transcript collections', () => {
    const withCursor = { ...empty, readCursor: { sessionId: 'session', key: 'a'.repeat(32) } };
    const changes = JSON.parse(JSON.stringify(diffConversation(empty, withCursor)));
    expect(changes).toEqual({ readCursor: withCursor.readCursor });
    const applied = reduceConversation(snapshot, { ...update, changes });
    expect(applied.conversation.readCursor).toEqual(withCursor.readCursor);
    expect(applied.conversation.messages).toBe(empty.messages);
    const cleared = JSON.parse(JSON.stringify(diffConversation(withCursor, empty)));
    expect(cleared).toEqual({ readCursor: null });
    expect(
      reduceConversation(applied, { ...update, baseRevision: 1, revision: 2, changes: cleared }).conversation
        .readCursor,
    ).toBeUndefined();
    expect(() =>
      parseConversationFrame({ ...update, changes: { readCursor: { sessionId: 'session', key: 12 } } }),
    ).toThrow('invalid_frame');
  });
  it.each([2, 3])('requires protocol %s clients to reload', (protocolVersion) => {
    expect(() => parseConversationFrame({ ...snapshot, protocolVersion })).toThrow('Chat protocol changed');
  });
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
  it('does not regress on an older snapshot from the same stream', () => {
    const current = reduceConversation(snapshot, update);
    expect(reduceConversation(current, snapshot)).toBe(current);
  });
  it('atomically applies removals, replacements and order changes', () => {
    const before = reduceConversation(snapshot, update);
    const after: Conversation = {
      ...next,
      messages: [{ ...next.messages[1], text: 'edited' }],
      timeline: [{ kind: 'message', messageId: 'two' }],
    };
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
    { ...snapshot, protocolVersion: 1 },
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
        changes: { ...update.changes, messages: { ...update.changes.messages!, order: ['missing'] } },
      }),
    ).toThrow('invalid_frame');
    expect(snapshot.conversation).toEqual(empty);
  });
  it('rejects missing, duplicated or unknown presentation rows atomically', () => {
    for (const timeline of [
      [],
      [{ kind: 'message' as const, messageId: 'missing' }],
      [
        { kind: 'message' as const, messageId: 'one' },
        { kind: 'message' as const, messageId: 'one' },
      ],
      [
        { kind: 'message' as const, messageId: 'one' },
        { kind: 'message' as const, messageId: 'two', statsTurnId: 'missing' },
      ],
    ]) {
      expect(() =>
        reduceConversation(snapshot, {
          ...update,
          changes: {
            ...update.changes,
            timeline: {
              upserts: timeline,
              removeIds: [],
              order: timeline.map((row) => JSON.stringify(['message', row.messageId])),
            },
          },
        }),
      ).toThrow('invalid_frame');
      expect(snapshot.conversation).toEqual(empty);
    }
  });
});
