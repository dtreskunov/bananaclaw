import { afterEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { applyHostEvent } from './host-state.js';
import { threadTitleInstruction } from '../thread-title-request.js';

afterEach(() => closeSessionDb());

function messagePayload(text: string) {
  return {
    id: 'in-1',
    seq: 2,
    kind: 'chat',
    timestamp: '2026-09-01 00:00:00',
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: 'in-1',
    tries: 0,
    trigger: 1,
    platform_id: 'chat-1',
    channel_type: 'web',
    thread_id: 'thread-1',
    content_base64: Buffer.from(JSON.stringify({ text })).toString('base64'),
    source_session_id: null,
    on_wake: 0,
    sender_user_id: null,
    sender_identity: 'web:user-1',
  };
}

describe('applyHostEvent', () => {
  it('applies the complete host event vocabulary in order', () => {
    initTestSessionDb({ unifiedHostProjection: true });
    let sequence = 0;
    const apply = (type: string, payload: Record<string, unknown>) =>
      applyHostEvent({ eventId: `host-${++sequence}`, sequence, event: { type, payload } });

    apply('sequence.floor', { seq: 2 });
    apply('routing.upsert', { channel_type: 'web', platform_id: 'chat-1', thread_id: 'thread-1' });
    apply('destinations.replace', {
      entries: [
        {
          name: 'current',
          display_name: 'Current chat',
          type: 'channel',
          channel_type: 'web',
          platform_id: 'chat-1',
          agent_group_id: null,
        },
      ],
    });
    apply('fork.upsert', {
      id: 1,
      parent_session_id: 'parent-1',
      parent_continuation: 'continuation-1',
      provider: 'native',
      anchor_ref: 'turn-1',
      digest: 'history',
      created_at: '2026-09-01 00:00:00',
    });
    expect(threadTitleInstruction()).toContain('<thread_title_request>');
    apply('thread-title.upsert', {
      channel_type: 'web',
      platform_id: 'chat-1',
      thread_id: 'thread-1',
      title: 'Host event projection',
      source: 'model',
      request_message_id: 'in-1',
      published: 0,
      updated_at: '2026-09-01 00:00:00',
    });
    apply('message.upsert', messagePayload('hello'));

    const db = getOutboundDb();
    expect(db.prepare("SELECT value FROM host_state WHERE key = 'sequence_floor'").get()).toEqual({ value: '2' });
    expect(db.prepare('SELECT channel_type, thread_id FROM session_routing').get()).toEqual({
      channel_type: 'web',
      thread_id: 'thread-1',
    });
    expect(db.prepare('SELECT name FROM destinations').get()).toEqual({ name: 'current' });
    expect(db.prepare('SELECT digest FROM fork_origin').get()).toEqual({ digest: 'history' });
    expect(threadTitleInstruction()).toBeNull();
    expect(db.prepare('SELECT content FROM messages_in').get()).toEqual({ content: '{"text":"hello"}' });
    expect(db.prepare('SELECT last_sequence FROM applied_host_events WHERE id = 1').get()).toEqual({
      last_sequence: sequence,
    });
  });

  it('acknowledges a replay without reapplying and rejects a gap atomically', () => {
    initTestSessionDb();
    const first = { eventId: 'host-1', sequence: 1, event: { type: 'message.upsert', payload: messagePayload('hello') } };
    expect(applyHostEvent(first)).toBe(true);
    expect(applyHostEvent(first)).toBe(false);
    expect(() =>
      applyHostEvent({ eventId: 'host-3', sequence: 3, event: { type: 'message.delete', payload: { id: 'in-1' } } }),
    ).toThrow('out-of-order host event');
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM messages_in').get()).toEqual({ count: 1 });
    expect(getOutboundDb().prepare('SELECT last_sequence FROM applied_host_events WHERE id = 1').get()).toEqual({
      last_sequence: 1,
    });
  });
});
