import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationTurn } from './conversation.js';
import {
  CONVERSATION_PROTOCOL_VERSION,
  diffConversation,
  parseConversationFrame,
  reduceConversation,
  type ConversationSnapshot,
  type ConversationUpdate,
} from './conversation-protocol.js';

const turn: ConversationTurn = {
  id: 'turn',
  phase: 'running',
  outcome: 'pending',
  startedAt: 1767225600000,
  endedAt: null,
  inputIds: [],
  outputIds: [],
  activity: Array.from({ length: 1000 }, (_, ordinal) => ({
    ordinal,
    ts: ordinal,
    text: JSON.stringify({ kind: 'tool', id: `tool-${ordinal}`, status: 'running', detail: 'x'.repeat(256) }),
    timelinePosition: ordinal + 1,
  })),
  usage: [],
  metadata: { status: 'provisional', model: null, durationMs: null },
};
const view: Conversation = {
  threadId: 'thread',
  messages: [],
  turns: [turn],
  interactions: [],
  timeline: [
    {
      kind: 'turn',
      turnId: turn.id,
      afterId: null,
      status: true,
      trace: { turnId: turn.id, ordinals: turn.activity.map((line) => line.ordinal), ownsTurn: true },
    },
  ],
  connection: { connected: true, activeTurnId: turn.id },
  capabilities: { canSend: true, stop: true, steer: false, editInput: false, cancelInput: false },
};
const snapshot: ConversationSnapshot = {
  kind: 'snapshot',
  protocolVersion: CONVERSATION_PROTOCOL_VERSION,
  streamId: 'stream',
  revision: 0,
  conversation: view,
};
const update = (changes: ConversationUpdate['changes']): ConversationUpdate => ({
  kind: 'update',
  protocolVersion: CONVERSATION_PROTOCOL_VERSION,
  streamId: snapshot.streamId,
  baseRevision: 0,
  revision: 1,
  changes,
});
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('incremental conversation activity', () => {
  it('sends exactly one lifecycle replacement, not the turn or its 1000-entry trace', () => {
    const line = { ...turn.activity[999], text: '{"kind":"tool","id":"tool-999","status":"completed"}' };
    const next = { ...view, turns: [{ ...turn, activity: [...turn.activity.slice(0, -1), line] }] };
    const patch = wire(diffConversation(view, next));
    expect(patch).toEqual({ activity: [{ turnId: turn.id, changes: { upserts: [line], removeIds: [] } }] });
    expect(JSON.stringify(update(patch)).length).toBeLessThan(512);
    const reduced = reduceConversation(snapshot, parseConversationFrame(wire(update(patch))));
    expect(reduced.conversation).toEqual(next);
    expect(reduced.conversation.turns[0].activity[0]).toBe(turn.activity[0]);
    expect(reduced.conversation.messages).toBe(view.messages);
    expect(reduced.conversation.timeline).toBe(view.timeline);
  });
  it('does not resend recorded activity when only turn phase or accounting changes', () => {
    const next = {
      ...view,
      turns: [{ ...turn, phase: 'stopping' as const, metadata: { ...turn.metadata, durationMs: 42 } }],
    };
    const patch = wire(diffConversation(view, next));
    expect(patch.activity).toBeUndefined();
    expect(patch.turns?.upserts).toHaveLength(1);
    expect(patch.turns?.upserts[0]).not.toHaveProperty('activity');
    expect(JSON.stringify(update(patch)).length).toBeLessThan(1024);
    const reduced = reduceConversation(snapshot, update(patch));
    expect(reduced.conversation).toEqual(next);
    expect(reduced.conversation.turns[0].activity).toBe(turn.activity);
  });
  it('adds and removes entries together with only affected timeline rows', () => {
    const added = { ordinal: 1000, ts: 1000, text: 'new', timelinePosition: 1001 };
    const next: Conversation = {
      ...view,
      turns: [{ ...turn, activity: [...turn.activity.slice(1), added] }],
      timeline: [
        {
          kind: 'turn',
          turnId: turn.id,
          afterId: null,
          status: true,
          trace: {
            turnId: turn.id,
            ordinals: [...turn.activity.slice(1).map((line) => line.ordinal), added.ordinal],
            ownsTurn: true,
          },
        },
      ],
    };
    const patch = wire(diffConversation(view, next));
    expect(patch.activity?.[0].changes.upserts).toEqual([added]);
    expect(patch.activity?.[0].changes.removeIds).toEqual([0]);
    expect(patch.turns).toBeUndefined();
    expect(patch.timeline?.upserts).toHaveLength(1);
    expect(patch.timeline?.order).toBeUndefined();
    expect(reduceConversation(snapshot, parseConversationFrame(wire(update(patch)))).conversation).toEqual(next);
  });
  it('applies settlement, output, trace ownership and turn fields atomically', () => {
    const reply = { id: 'reply', direction: 'out' as const, turnId: turn.id, text: 'Done', timestamp: 1767225601000 };
    const next: Conversation = {
      ...view,
      messages: [reply],
      turns: [{ ...turn, phase: 'settled', outcome: 'replied', endedAt: 1767225601000, outputIds: [reply.id] }],
      timeline: [
        {
          kind: 'message',
          messageId: reply.id,
          statsTurnId: turn.id,
          trace: { turnId: turn.id, ordinals: turn.activity.map((line) => line.ordinal), ownsTurn: true },
        },
      ],
      connection: { connected: true, activeTurnId: null },
    };
    const patch = wire(diffConversation(view, next));
    expect(patch.activity).toBeUndefined();
    expect(reduceConversation(snapshot, parseConversationFrame(wire(update(patch)))).conversation).toEqual(next);
    expect(() => reduceConversation(snapshot, update({ ...patch, timeline: undefined }))).toThrow('invalid_frame');
    expect(snapshot.conversation).toBe(view);
  });
  it('rejects unknown or duplicate activity owners and missing timeline placements', () => {
    const changes = { upserts: [{ ...turn.activity[0], text: 'replacement' }], removeIds: [] };
    for (const activity of [
      [{ turnId: 'missing', changes }],
      [
        { turnId: turn.id, changes },
        { turnId: turn.id, changes },
      ],
      [{ turnId: turn.id, changes: { upserts: [], removeIds: [0] } }],
    ])
      expect(() => reduceConversation(snapshot, update({ activity }))).toThrow('invalid_frame');
    expect(() =>
      parseConversationFrame(
        update({
          turns: { upserts: [turn], removeIds: [] },
        }),
      ),
    ).toThrow('invalid_frame');
    expect(snapshot.conversation.turns[0].activity).toHaveLength(1000);
  });
  it('restores complete traces from a fresh snapshot after a gap or reconnect', () => {
    expect(() => reduceConversation(snapshot, { ...update({}), baseRevision: 2, revision: 3 })).toThrow('revision_gap');
    const recovered = reduceConversation(snapshot, { ...snapshot, streamId: 'reconnected' });
    expect(recovered.conversation.turns[0].activity).toHaveLength(1000);
    expect(reduceConversation(snapshot, update({})).conversation.turns).toBe(view.turns);
  });
});
