import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '.test-durable-link',
}));

import { initSessionFolder, outboundDbPath, openInboundDb } from './session-manager.js';
import { applyDurableRunnerEvent } from './session-link-durable.js';
import { log } from './log.js';

const ROOT = '.test-durable-link';
const AGENT_GROUP_ID = 'agent-a';
const SESSION_ID = 'session-a';

function messagePayload(content: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'out-1',
    turn_id: null,
    seq: 1,
    in_reply_to: null,
    timestamp: '2026-09-01 00:00:00',
    deliver_after: null,
    recurrence: null,
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify(content),
  };
}

function timingPayload(duration: unknown): Record<string, unknown> {
  return {
    id: 'usage-timing',
    turn_id: null,
    message_out_id: null,
    cost_usd: 0.00773868,
    input_tokens: 25490,
    output_tokens: 70,
    cache_read_tokens: 128,
    cache_write_tokens: 0,
    reasoning_tokens: null,
    num_turns: 1,
    duration_ms: 11888,
    duration_api_ms: duration,
    model: 'minimax/MiniMax-M3',
    context_window: 1000000,
    max_output_tokens: 512000,
    context_tokens: 25688,
    timestamp: '2026-10-06 05:45:04',
  };
}

beforeEach(() => {
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  fs.rmSync(ROOT, { recursive: true, force: true });
  initSessionFolder(AGENT_GROUP_ID, SESSION_ID);
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('applyDurableRunnerEvent', () => {
  it.each([null, 0, 3328.568369, Number.MAX_SAFE_INTEGER])(
    'replays model timing %s before the saved reply and settlement without changing replay identity',
    (duration) => {
      const turn = {
        id: 'timed-turn',
        origin_channel_type: 'web',
        origin_platform_id: 'chat',
        origin_thread_id: null,
        origin_source_session_id: null,
        started_at: '2026-10-06T05:44:52.674Z',
        ended_at: null,
        phase: 'running',
        outcome: 'pending',
        provenance: 'native',
        imported_from_session_id: null,
        imported_from_turn_id: null,
      };
      const apply = (sequence: number, type: string, payload: Record<string, unknown>) =>
        applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
          sequence,
          eventId: `timing-recovery-${sequence}`,
          event: { type, payload },
        });
      apply(1, 'turn.upsert', turn);
      const usage: Record<string, unknown> = { ...timingPayload(duration), turn_id: turn.id };
      apply(2, 'usage.persist', usage);
      apply(2, 'usage.persist', usage);
      expect(usage.duration_api_ms).toBe(duration);
      if (duration !== null && !Number.isInteger(duration))
        expect(() => apply(2, 'usage.persist', { ...usage, duration_api_ms: Math.round(duration) })).toThrow(
          'conflicting durable event replay',
        );
      apply(3, 'message.upsert', { ...messagePayload({ text: 'Saved reply' }), turn_id: turn.id });
      apply(4, 'state.upsert', {
        key: `turn-metadata:${turn.id}`,
        updated_at: 'now',
        value: JSON.stringify({
          turnId: turn.id,
          durationMs: 27900,
          model: 'minimax/MiniMax-M3',
          usageId: 'usage-timing',
          status: 'final',
          final: true,
        }),
      });
      const completed = { ...turn, phase: 'settled', outcome: 'replied', ended_at: '2026-10-06T05:45:20.574Z' };
      expect(apply(5, 'turn.upsert', completed).settledTurnId).toBe(turn.id);
      apply(5, 'turn.upsert', completed);
      const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
      try {
        expect(db.prepare('SELECT duration_api_ms, typeof(duration_api_ms) AS type FROM turn_usage').get()).toEqual({
          duration_api_ms: duration === null ? null : Math.round(duration),
          type: duration === null ? 'null' : 'integer',
        });
        expect(db.prepare('SELECT phase, outcome FROM turns').get()).toEqual({ phase: 'settled', outcome: 'replied' });
        expect(db.prepare('SELECT id, content FROM messages_out').all()).toEqual([
          { id: 'out-1', content: '{"text":"Saved reply"}' },
        ]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM applied_runner_events').get()).toEqual({ n: 5 });
      } finally {
        db.close();
      }
    },
  );

  it.each([-0.1, '3328.568369', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined])(
    'warns and skips invalid model timing %s without projecting usage',
    (duration) => {
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        sequence: 1,
        eventId: 'invalid-duration',
        event: { type: 'usage.persist', payload: timingPayload(duration) },
      });
      expect(log.warn).toHaveBeenCalledWith('Skipped invalid optional runner telemetry', {
        sessionId: SESSION_ID,
        eventId: 'invalid-duration',
        sequence: 1,
        type: 'usage.persist',
        error: 'invalid usage.persist payload',
      });
      const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
      try {
        expect(db.prepare('SELECT COUNT(*) FROM turn_usage').pluck().get()).toBe(0);
        expect(db.prepare('SELECT sequence FROM applied_runner_events').pluck().get()).toBe(1);
      } finally {
        db.close();
      }
    },
  );

  it('keeps token counts integer-only while tolerating legacy fractional model timing', () => {
    applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      sequence: 1,
      eventId: 'invalid-token-count',
      event: { type: 'usage.persist', payload: { ...timingPayload(3328.568369), output_tokens: 70.5 } },
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Skipped invalid optional runner telemetry',
      expect.objectContaining({ error: 'invalid usage.persist payload' }),
    );
  });

  it.each([
    ['null usage', 'usage.persist', null, 'invalid telemetry payload'],
    ['array usage', 'usage.persist', [], 'invalid telemetry payload'],
    ['invalid usage fields', 'usage.persist', {}, 'invalid usage.persist payload'],
    ['missing usage turn', 'usage.persist', { ...timingPayload(null), turn_id: 'missing' }, 'unknown turn'],
    ['null activity', 'activity.persist', null, 'invalid telemetry payload'],
    ['invalid activity fields', 'activity.persist', {}, 'invalid activity.persist payload'],
    [
      'malformed metadata JSON',
      'state.upsert',
      {
        key: 'turn-metadata:optional-turn',
        value: '{',
        updated_at: 'now',
      },
      'invalid turn metadata JSON',
    ],
    [
      'invalid metadata fields',
      'state.upsert',
      {
        key: 'turn-metadata:optional-turn',
        value: '{}',
        updated_at: 'now',
      },
      'invalid turn metadata',
    ],
    [
      'invalid metadata envelope',
      'state.upsert',
      {
        key: 'turn-metadata:optional-turn',
        value: null,
        updated_at: 'now',
      },
      'invalid state.upsert payload',
    ],
    [
      'missing usage reference',
      'state.upsert',
      {
        key: 'turn-metadata:optional-turn',
        updated_at: 'now',
        value: JSON.stringify({
          turnId: 'optional-turn',
          durationMs: 1000,
          model: null,
          usageId: 'skipped-usage',
          status: 'final',
          final: true,
        }),
      },
      'turn metadata references unrelated usage',
    ],
  ] as const)(
    'warns once for %s and lets the saved response settle without telemetry',
    (_label, type, payload, error) => {
      const turn = {
        id: 'optional-turn',
        origin_channel_type: 'web',
        origin_platform_id: 'chat',
        origin_thread_id: null,
        origin_source_session_id: null,
        started_at: '2026-10-06T05:44:52.674Z',
        ended_at: null,
        phase: 'running',
        outcome: 'pending',
        provenance: 'native',
        imported_from_session_id: null,
        imported_from_turn_id: null,
      };
      const apply = (sequence: number, eventType: string, value: unknown) =>
        applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
          sequence,
          eventId: `optional-${sequence}`,
          event: { type: eventType, payload: value },
        });
      apply(1, 'turn.upsert', turn);
      expect(apply(2, type, payload)).toEqual({ deliveryReady: false, processingReady: false });
      apply(2, type, payload);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith('Skipped invalid optional runner telemetry', {
        sessionId: SESSION_ID,
        eventId: 'optional-2',
        sequence: 2,
        type,
        error,
      });
      expect(() => apply(2, type, { different: true })).toThrow('conflicting durable event replay');
      expect(() => apply(4, type, payload)).toThrow('out-of-order durable event');
      expect(
        apply(3, 'message.upsert', {
          ...messagePayload({ text: 'Saved response', delivery_origin: 'response' }),
          turn_id: turn.id,
        }).deliveryReady,
      ).toBe(false);
      expect(
        apply(4, 'turn.upsert', {
          ...turn,
          phase: 'settled',
          outcome: 'replied',
          ended_at: '2026-10-06T05:45:20.574Z',
        }).settledTurnId,
      ).toBe(turn.id);
      const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
      try {
        expect(db.prepare('SELECT phase, outcome FROM turns').get()).toEqual({ phase: 'settled', outcome: 'replied' });
        expect(db.prepare('SELECT COUNT(*) FROM messages_out').pluck().get()).toBe(1);
        expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(4);
        expect(db.prepare('SELECT COUNT(*) FROM turn_usage').pluck().get()).toBe(0);
        expect(db.prepare('SELECT COUNT(*) FROM turn_activity').pluck().get()).toBe(0);
        expect(db.prepare("SELECT COUNT(*) FROM session_state WHERE key LIKE 'turn-metadata:%'").pluck().get()).toBe(0);
      } finally {
        db.close();
      }
    },
  );

  it('does not acknowledge optional telemetry when its database projection fails', () => {
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    try {
      db.exec(
        "CREATE TRIGGER reject_usage BEFORE INSERT ON turn_usage BEGIN SELECT RAISE(ABORT, 'projection unavailable'); END",
      );
      expect(() =>
        applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
          sequence: 1,
          eventId: 'database-failure',
          event: { type: 'usage.persist', payload: timingPayload(null) },
        }),
      ).toThrow('projection unavailable');
      expect(log.warn).not.toHaveBeenCalled();
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM turn_usage').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('preserves explicit activity order through replay and output reanchoring', () => {
    const apply = (sequence: number, type: string, payload: Record<string, unknown>) =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        sequence,
        eventId: `activity-order-${sequence}`,
        event: { type, payload },
      });
    apply(1, 'turn.upsert', {
      id: 'logical-turn',
      origin_channel_type: 'web',
      origin_platform_id: 'chat',
      origin_thread_id: null,
      origin_source_session_id: null,
      started_at: 'now',
      ended_at: null,
      phase: 'running',
      outcome: 'pending',
      provenance: 'native',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    });
    apply(2, 'message.upsert', { ...messagePayload({ text: 'hello' }), turn_id: 'logical-turn' });
    const activity = {
      turn_id: 'logical-turn',
      message_out_id: null,
      ordinal: 0,
      ts: '123',
      text: 'work',
      timeline_position: 500,
    };
    apply(3, 'activity.persist', activity);
    apply(3, 'activity.persist', activity);
    apply(4, 'activity.persist', { ...activity, message_out_id: 'out-1' });
    apply(5, 'activity.persist', { ...activity, timeline_position: -1 });
    apply(6, 'activity.persist', { ...activity, timeline_position: 501 });
    const { timeline_position: _position, ...legacy } = activity;
    apply(7, 'activity.persist', legacy);
    expect(vi.mocked(log.warn).mock.calls.map((call) => call[1]?.error)).toEqual([
      'invalid activity.persist payload',
      'immutable activity position',
      'invalid activity.persist payload',
    ]);
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT message_out_id, timeline_position FROM turn_activity').all()).toEqual([
        { message_out_id: 'out-1', timeline_position: 500 },
      ]);
    } finally {
      db.close();
    }
  });
  it('projects turn identity before associations and rejects missing or reassigned identities', () => {
    const turn = {
      id: 'logical-turn',
      origin_channel_type: 'web',
      origin_platform_id: 'chat',
      origin_thread_id: null,
      origin_source_session_id: null,
      started_at: '2026-09-01T00:00:00.000Z',
      ended_at: null,
      phase: 'running',
      outcome: 'pending',
      provenance: 'native',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    };
    const apply = (sequence: number, type: string, payload: Record<string, unknown>) =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        sequence,
        eventId: `turn-event-${sequence}`,
        event: { type, payload },
      });
    expect(() => apply(1, 'message.upsert', { ...messagePayload({ text: 'hello' }), turn_id: turn.id })).toThrow(
      'unknown turn',
    );
    apply(1, 'turn.upsert', turn);
    apply(2, 'turn-input.upsert', { turn_id: turn.id, message_in_id: 'in-1', association: 'consumed' });
    apply(3, 'message.upsert', { ...messagePayload({ text: 'hello' }), turn_id: turn.id });
    apply(4, 'activity.persist', {
      turn_id: turn.id,
      message_out_id: null,
      ordinal: 0,
      ts: '123',
      text: 'work',
      timeline_position: 1,
    });
    apply(4, 'activity.persist', {
      turn_id: turn.id,
      message_out_id: null,
      ordinal: 0,
      ts: '123',
      text: 'work',
      timeline_position: 1,
    });
    expect(() => apply(5, 'turn.upsert', { ...turn, started_at: 'different' })).toThrow('immutable turn identity');
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT turn_id FROM messages_out').pluck().get()).toBe(turn.id);
      expect(db.prepare('SELECT turn_id FROM turn_inputs').pluck().get()).toBe(turn.id);
      expect(db.prepare('SELECT count(*) FROM turn_activity').pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });
  const editId = '64192f5f-2016-4a4b-8a10-f215f780275e';
  function seedEdit() {
    const db = openInboundDb(AGENT_GROUP_ID, SESSION_ID);
    db.prepare(
      `INSERT INTO messages_in
        (id, seq, kind, timestamp, content, sender_user_id, channel_type, platform_id, thread_id)
        VALUES (?, ?, ?, 'now', ?, '11111111-1111-4111-8111-111111111111', 'web', 'platform', 'thread')`,
    ).run('in-1', 2, 'chat', JSON.stringify({ text: 'before', files: [{ filename: 'keep.txt' }] }));
    db.prepare(
      `INSERT INTO messages_in
        (id, seq, kind, timestamp, content, sender_user_id, channel_type, platform_id, thread_id)
        VALUES (?, 4, 'system', 'now', ?, '11111111-1111-4111-8111-111111111111', 'web', 'platform', 'thread')`,
    ).run(
      `edit-${editId}`,
      JSON.stringify({
        action: 'edit_input',
        requestId: editId,
        messageId: 'in-1',
        expectedText: 'before',
        replacementText: 'after',
      }),
    );
    db.close();
  }
  function editFrame(status = 'accepted') {
    return {
      eventId: 'edit-result',
      sequence: 1,
      event: {
        type: 'state.upsert',
        payload: {
          key: `input-edit:${editId}`,
          value: JSON.stringify({ requestId: editId, messageId: 'in-1', status }),
          updated_at: 'now',
        },
      },
    };
  }

  it('commits edited host text, receipt and host replay event atomically and ignores duplicate delivery', () => {
    seedEdit();
    const frame = editFrame();
    expect(applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, frame).editedInput?.text).toBe('after');
    expect(applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, frame).editedInput?.text).toBe('after');
    const inDb = openInboundDb(AGENT_GROUP_ID, SESSION_ID);
    try {
      const row = inDb.prepare("SELECT seq, content FROM messages_in WHERE id = 'in-1'").get() as {
        seq: number;
        content: string;
      };
      expect(row.seq).toBe(2);
      expect(JSON.parse(row.content)).toEqual({ text: 'after', files: [{ filename: 'keep.txt' }] });
      expect(
        inDb
          .prepare(
            "SELECT COUNT(*) FROM pending_host_events WHERE event_type = 'message.upsert' AND json_extract(payload, '$.id') = 'in-1'",
          )
          .pluck()
          .get(),
      ).toBe(2);
    } finally {
      inDb.close();
    }
  });

  it('rejects invented editing receipts without advancing the ledger', () => {
    expect(() => applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, editFrame())).toThrow('no host request');
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    expect(db.prepare('SELECT COUNT(*) FROM session_state').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
    db.close();
  });

  it('atomically projects cancellation and replays it without resurrecting a message', () => {
    seedEdit();
    const db = openInboundDb(AGENT_GROUP_ID, SESSION_ID);
    db.prepare('UPDATE messages_in SET id = ?, content = ? WHERE id = ?').run(
      `cancel-${editId}`,
      JSON.stringify({ action: 'cancel_input', requestId: editId, messageId: 'in-1' }),
      `edit-${editId}`,
    );
    db.close();
    const frame = editFrame();
    frame.event.payload.key = `input-cancel:${editId}`;
    expect(applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, frame).editedInput?.cancelled).toBe(true);
    expect(applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, frame).editedInput?.cancelled).toBe(true);
    const inbound = openInboundDb(AGENT_GROUP_ID, SESSION_ID);
    expect(inbound.prepare("SELECT status FROM messages_in WHERE id = 'in-1'").pluck().get()).toBe('completed');
    expect(
      JSON.parse(inbound.prepare("SELECT content FROM messages_in WHERE id = 'in-1'").pluck().get() as string),
    ).toEqual({ text: 'before', files: [{ filename: 'keep.txt' }], cancelled: true });
    inbound.close();
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        ...frame,
        eventId: 'forged-update',
        sequence: 2,
        event: {
          ...frame.event,
          payload: {
            ...frame.event.payload,
            value: JSON.stringify({ requestId: editId, messageId: 'in-1', status: 'conflict' }),
          },
        },
      }),
    ).toThrow('conflicting input edit receipt');
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'delete-cancel',
        sequence: 2,
        event: { type: 'state.delete', payload: { key: `input-cancel:${editId}` } },
      }),
    ).toThrow('immutable');
  });

  it('rejects cancellation receipts without a matching authorized host cancellation command', () => {
    seedEdit();
    const frame = editFrame();
    frame.event.payload.key = `input-cancel:${editId}`;
    expect(() => applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, frame)).toThrow('no host request');
  });

  it('rolls back the receipt if the host target no longer matches the authorized request', () => {
    seedEdit();
    const inDb = openInboundDb(AGENT_GROUP_ID, SESSION_ID);
    inDb
      .prepare("UPDATE messages_in SET sender_user_id = '22222222-2222-4222-8222-222222222222' WHERE id = 'in-1'")
      .run();
    inDb.close();
    expect(() => applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, editFrame())).toThrow('target mismatches');
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    expect(db.prepare('SELECT COUNT(*) FROM session_state').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
    db.close();
  });

  it('persists a conflict without updating the pending message', () => {
    seedEdit();
    applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, editFrame('conflict'));
    const db = openInboundDb(AGENT_GROUP_ID, SESSION_ID);
    expect(db.prepare("SELECT json_extract(content, '$.text') FROM messages_in WHERE id = 'in-1'").pluck().get()).toBe(
      'before',
    );
    db.close();
  });

  it('never reverts a later edit when an earlier receipt is replayed', () => {
    seedEdit();
    const first = editFrame();
    applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, first);
    const secondId = '64192f5f-2016-4a4b-8a10-f215f780275f';
    const inDb = openInboundDb(AGENT_GROUP_ID, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in
        (id, seq, kind, timestamp, content, sender_user_id, channel_type, platform_id, thread_id)
        VALUES (?, 6, 'system', 'now', ?, '11111111-1111-4111-8111-111111111111', 'web', 'platform', 'thread')`,
      )
      .run(
        `edit-${secondId}`,
        JSON.stringify({
          action: 'edit_input',
          requestId: secondId,
          messageId: 'in-1',
          expectedText: 'after',
          replacementText: 'latest',
        }),
      );
    inDb.close();
    applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'second-edit',
      sequence: 2,
      event: {
        type: 'state.upsert',
        payload: {
          key: `input-edit:${secondId}`,
          value: JSON.stringify({ requestId: secondId, messageId: 'in-1', status: 'accepted' }),
          updated_at: 'now',
        },
      },
    });
    expect(applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, first).editedInput?.text).toBe('latest');
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        ...editFrame('conflict'),
        eventId: 'overwrite-receipt',
        sequence: 3,
      }),
    ).toThrow('conflicting input edit receipt');
  });

  it('applies the complete durable event vocabulary in journal order', () => {
    let sequence = 0;
    const apply = (type: string, payload: Record<string, unknown>) =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: `event-${++sequence}`,
        sequence,
        event: { type, payload },
      });

    apply('message.upsert', {
      id: 'out-1',
      turn_id: null,
      seq: 1,
      in_reply_to: null,
      timestamp: '2026-09-01 00:00:00',
      deliver_after: null,
      recurrence: null,
      kind: 'chat',
      platform_id: 'chat-1',
      channel_type: 'web',
      thread_id: null,
      content: '{"text":"hello"}',
    });
    apply('processing.upsert', {
      message_id: 'in-1',
      status: 'processing',
      status_changed: '2026-09-01 00:00:01',
    });
    apply('state.upsert', {
      key: 'continuation:native',
      value: 'continuation-1',
      updated_at: '2026-09-01 00:00:02',
    });
    apply('container.upsert', {
      id: 1,
      current_tool: 'Bash',
      tool_declared_timeout_ms: 1000,
      tool_started_at: '2026-09-01 00:00:03',
      updated_at: '2026-09-01 00:00:03',
    });
    apply('checkpoint.upsert', {
      message_out_id: 'out-1',
      provider: 'native',
      continuation: 'continuation-1',
      provider_turn_ref: 'turn-1',
      created_at: '2026-09-01 00:00:04',
    });
    apply('activity.persist', {
      turn_id: null,
      message_out_id: 'out-1',
      ordinal: 0,
      ts: '1',
      text: '{"kind":"notification","id":"n1","text":"ok"}',
      timeline_position: 100,
    });
    apply('usage.persist', {
      turn_id: null,
      id: 'usage-1',
      message_out_id: 'out-1',
      cost_usd: 0.1,
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: null,
      num_turns: null,
      duration_ms: null,
      duration_api_ms: null,
      model: 'test/model',
      context_window: null,
      max_output_tokens: null,
      context_tokens: null,
      timestamp: '2026-09-01 00:00:05',
    });
    apply('task-attempt.upsert', {
      task_message_id: 'task-1',
      series_id: 'series-1',
      trigger_source: 'manual',
      status: 'skipped',
      started_at: '2026-09-01 00:00:06',
      completed_at: '2026-09-01 00:00:07',
      duration_ms: 1,
      exit_code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      error: null,
      wake_agent: 0,
      provider_invoked: 0,
    });
    apply('processing.delete', { message_id: 'in-1' });
    apply('state.delete', { key: 'continuation:native' });

    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT id, seq FROM messages_out').all()).toEqual([{ id: 'out-1', seq: 1 }]);
      expect(db.prepare('SELECT * FROM processing_ack').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM session_state').all()).toEqual([]);
      expect(db.prepare('SELECT current_tool FROM container_state').pluck().get()).toBe('Bash');
      expect(db.prepare('SELECT provider_turn_ref FROM turn_checkpoints').pluck().get()).toBe('turn-1');
      expect(db.prepare('SELECT text FROM turn_activity').pluck().get()).toContain('notification');
      expect(db.prepare('SELECT model FROM turn_usage').pluck().get()).toBe('test/model');
      expect(db.prepare('SELECT status FROM task_attempts').pluck().get()).toBe('skipped');
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(sequence);
    } finally {
      db.close();
    }
  });

  it('rejects malformed message content without advancing the event ledger', () => {
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: {
          type: 'message.upsert',
          payload: {
            id: 'out-1',
            turn_id: null,
            seq: 1,
            in_reply_to: null,
            timestamp: 'now',
            deliver_after: null,
            recurrence: null,
            kind: 'chat',
            platform_id: null,
            channel_type: null,
            thread_id: null,
            content: 'not-json',
          },
        },
      }),
    ).toThrow('invalid message content');

    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM messages_out').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each([
    [
      'too many files',
      { files: Array.from({ length: 33 }, (_, index) => `file-${index}.txt`) },
      'invalid outbound files',
    ],
    ['unsafe file name', { files: ['../secret.txt'] }, 'invalid outbound files'],
    [
      'too many question options',
      { options: Array.from({ length: 51 }, (_, index) => `option-${index}`) },
      'invalid question options',
    ],
  ])('rejects message content with %s', (_label, content, error) => {
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: { type: 'message.upsert', payload: messagePayload(content) },
      }),
    ).toThrow(error);
  });

  it('rejects excessively deep message content', () => {
    let content: Record<string, unknown> = { value: 'leaf' };
    for (let depth = 0; depth < 17; depth++) content = { nested: content };
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: { type: 'message.upsert', payload: messagePayload(content) },
      }),
    ).toThrow('message content exceeds structural limits');
  });

  it.each([
    [
      'oversized session state',
      'state.upsert',
      { key: 'continuation:native', value: 'x'.repeat(1024 * 1024 + 1), updated_at: '2026-09-01 00:00:00' },
      'invalid state.upsert payload',
    ],
    [
      'oversized declared tool timeout',
      'container.upsert',
      {
        id: 1,
        current_tool: 'Bash',
        tool_declared_timeout_ms: 6 * 60 * 60 * 1000 + 1,
        tool_started_at: '2026-09-01 00:00:00',
        updated_at: '2026-09-01 00:00:00',
      },
      'invalid container.upsert payload',
    ],
  ])('rejects %s without advancing the ledger', (_label, type, payload, error) => {
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'bad-1',
        sequence: 1,
        event: { type, payload },
      }),
    ).toThrow(error);
    const db = new Database(outboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM applied_runner_events').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('defers response delivery until the turn persistence marker', () => {
    const turn = {
      id: 'settled-turn',
      origin_channel_type: 'web',
      origin_platform_id: 'chat-1',
      origin_thread_id: null,
      origin_source_session_id: null,
      started_at: '2026-09-01T00:00:00.000Z',
      ended_at: null,
      phase: 'running',
      outcome: 'pending',
      provenance: 'native',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    };
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'unstarted-settlement',
        sequence: 1,
        event: {
          type: 'turn.upsert',
          payload: {
            ...turn,
            phase: 'settled',
            outcome: 'replied',
            ended_at: '2026-09-01T00:00:01.000Z',
          },
        },
      }),
    ).toThrow('turn identity must precede settlement');
    applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'turn-start',
      sequence: 1,
      event: { type: 'turn.upsert', payload: turn },
    });
    const messageResult = applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'event-1',
      sequence: 2,
      event: {
        type: 'message.upsert',
        payload: {
          id: 'out-1',
          turn_id: turn.id,
          seq: 1,
          in_reply_to: null,
          timestamp: '2026-09-01 00:00:00',
          deliver_after: null,
          recurrence: null,
          kind: 'chat',
          platform_id: 'chat-1',
          channel_type: 'web',
          thread_id: null,
          content: '{"text":"hello","delivery_origin":"response"}',
        },
      },
    });
    expect(messageResult.deliveryReady).toBe(false);

    const settled = { ...turn, phase: 'settled', outcome: 'replied', ended_at: '2026-09-01T00:00:01.000Z' };
    applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'metadata',
      sequence: 3,
      event: {
        type: 'state.upsert',
        payload: {
          key: `turn-metadata:${turn.id}`,
          updated_at: 'now',
          value: JSON.stringify({
            turnId: turn.id,
            durationMs: 1000,
            model: null,
            usageId: null,
            status: 'unavailable',
            final: true,
          }),
        },
      },
    });
    const turnResult = applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'event-2',
      sequence: 4,
      event: { type: 'turn.upsert', payload: settled },
    });
    expect(turnResult.deliveryReady).toBe(true);
    expect(turnResult.changedTurnIds).toEqual([turn.id]);
    expect(turnResult.settledTurnId).toBe(turn.id);
    const replay = applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
      eventId: 'event-2',
      sequence: 4,
      event: { type: 'turn.upsert', payload: settled },
    });
    expect(replay.changedTurnIds).toBeUndefined();
    expect(() =>
      applyDurableRunnerEvent(AGENT_GROUP_ID, SESSION_ID, {
        eventId: 'regression',
        sequence: 5,
        event: { type: 'turn.upsert', payload: turn },
      }),
    ).toThrow('already settled');
  });
});
