import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { linkTurnInput, putTurn, type TurnRow } from '../../../db/turns.js';
import {
  CONVERSATION_PROTOCOL_VERSION,
  parseConversationFrame,
  reduceConversation,
} from '../../shared/conversation-protocol.js';
import type { ConversationMessage } from '../../shared/conversation.js';
import { projectConversation } from './conversation.js';

let db: Database.Database;
const context = { sessionId: 's', channelType: 'web', platformIds: ['group:g'], threadId: 't', canSend: true };
const turn: TurnRow = {
  id: 'turn',
  phase: 'running',
  outcome: 'pending',
  provenance: 'native',
  origin_channel_type: 'web',
  origin_platform_id: 'group:g',
  origin_thread_id: 't',
  origin_source_session_id: null,
  started_at: 1790640000000,
  ended_at: null,
  imported_from_session_id: null,
  imported_from_turn_id: null,
};
const output: ConversationMessage = {
  id: 'out',
  direction: 'out',
  timestamp: 1790640001000,
  text: 'answer',
  turnId: 'turn',
  deliveryOrigin: 'response',
};
const signals = {
  active: {
    connected: true,
    turn: {
      id: 'turn',
      status: 'running' as const,
      channelType: 'web',
      platformId: 'group:g',
      threadId: 't',
      supportsSteering: true,
      supportsInputEditing: true,
      supportsInputCancellation: true,
    },
  },
  activity: [{ turnId: 'turn', ordinal: 1, ts: 1, text: 'work', timelinePosition: 100 }],
  usage: null,
};
const read = (history: ConversationMessage[] = []) => projectConversation(db, context, 't', 'g', history, signals);
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(OUTBOUND_SCHEMA);
  putTurn(db, turn);
});
afterEach(() => db.close());

describe('authoritative conversation projection', () => {
  it('uses a constant number of scoped queries as the conversation grows', () => {
    const history: ConversationMessage[] = [];
    for (let index = 0; index < 80; index++) {
      const id = `batch-${String(index).padStart(3, '0')}`;
      putTurn(db, { ...turn, id, phase: 'settled', outcome: 'replied', started_at: index, ended_at: index + 1 });
      linkTurnInput(db, { turn_id: id, message_in_id: `${id}-in`, association: 'consumed' });
      history.push({ id: `${id}-in`, direction: 'in', timestamp: index, text: id });
      history.push({ ...output, id: `${id}-out`, turnId: id });
      db.prepare('INSERT INTO turn_activity(turn_id,ordinal,ts,text,timeline_position) VALUES(?,0,?,?,100)').run(
        id,
        index,
        id,
      );
      db.prepare('INSERT INTO turn_usage(id,turn_id,input_tokens) VALUES(?,?,?)').run(id, id, index);
      db.prepare('INSERT INTO session_state(key,value,updated_at) VALUES(?,?,0)').run(
        `turn-metadata:${id}`,
        JSON.stringify({ turnId: id, durationMs: index, model: id, usageId: id, status: 'final', final: true }),
      );
    }
    const prepare = vi.spyOn(db, 'prepare');
    try {
      const view = read(history);
      expect(prepare).toHaveBeenCalledTimes(5);
      expect(view.turns).toHaveLength(81);
      for (const projected of view.turns.filter((entry) => entry.id.startsWith('batch-'))) {
        expect(projected.inputIds).toEqual([`${projected.id}-in`]);
        expect(projected.outputIds).toEqual([`${projected.id}-out`]);
        expect(projected.activity[0].text).toBe(projected.id);
        expect(projected.usage[0].id).toBe(projected.id);
        expect(projected.metadata.model).toBe(projected.id);
      }
    } finally {
      prepare.mockRestore();
    }
  });

  it('keeps epoch-zero request times, earliest duplicate submissions and nullable starts', () => {
    linkTurnInput(db, { turn_id: turn.id, message_in_id: 'input', association: 'consumed' });
    putTurn(db, { ...turn, id: 'previous', started_at: -1000, ended_at: -250 });
    putTurn(db, { ...turn, started_at: 0 });
    const input = (timestamp: number): ConversationMessage => ({ id: 'input', direction: 'in', timestamp, text: '' });
    const requested = (history: ConversationMessage[]) =>
      read(history).turns.find((entry) => entry.id === turn.id)?.requestedAt;
    expect(requested([input(0)])).toBe(0);
    expect(requested([input(0), input(-500)])).toBe(-250);
    putTurn(db, { ...turn, id: 'previous', started_at: -1000, ended_at: 10 });
    expect(requested([input(-500)])).toBe(-500);
    expect(requested([])).toBeNull();
    putTurn(db, { ...turn, started_at: null });
    expect(requested([input(0)])).toBeNull();
  });

  it('does not read or decode malformed metadata belonging to another route', () => {
    putTurn(db, { ...turn, id: 'private', phase: 'settled', origin_thread_id: 'private' });
    db.prepare('INSERT INTO session_state(key,value,updated_at) VALUES(?,?,0)').run(
      'turn-metadata:private',
      '{malformed',
    );
    expect(read().turns.map((entry) => entry.id)).toEqual([turn.id]);
  });

  it('does not mistake an unanchored usage row for an output whose literal id is null', () => {
    putTurn(db, {
      ...turn,
      phase: 'settled',
      provenance: 'backfill',
      origin_channel_type: null,
      origin_platform_id: null,
    });
    db.prepare('INSERT INTO turn_usage(id,turn_id,message_out_id,cost_usd) VALUES(?,?,?,?)').run(
      'visible',
      turn.id,
      'null',
      0.1,
    );
    db.prepare('INSERT INTO turn_usage(id,turn_id,cost_usd) VALUES(?,?,?)').run('unanchored', turn.id, 10);
    expect(read([{ ...output, id: 'null' }]).turns[0].usage.map((row) => row.id)).toEqual(['visible']);
  });

  it('reuses authorized message bodies and only copies to remove off-route turn associations', () => {
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied' });
    expect(read([output]).messages[0]).toBe(output);
    putTurn(db, { ...turn, id: 'foreign', origin_thread_id: 'other', phase: 'settled', outcome: 'replied' });
    const offRoute = { ...output, turnId: 'foreign' };
    const projected = read([offRoute]).messages[0];
    expect(projected).not.toBe(offRoute);
    expect(projected.turnId).toBeUndefined();
    expect(offRoute.turnId).toBe('foreign');
  });

  it('gates per-tool cancellation on the route-matched live capability, not saved provider configuration', () => {
    const capable = {
      ...signals,
      active: { connected: true, turn: { ...signals.active.turn, supportsToolCancellation: true } },
    };
    const readSignals = (current: typeof capable) => projectConversation(db, context, 't', 'g', [], current);
    expect(readSignals(capable).capabilities.stopTool).toBe(true);
    expect(readSignals({ ...capable, active: { ...capable.active, connected: false } }).capabilities.stopTool).toBe(
      false,
    );
    expect(
      readSignals({
        ...capable,
        active: { ...capable.active, turn: { ...capable.active.turn, threadId: 'other-thread' } },
      }).capabilities.stopTool,
    ).toBe(false);
    putTurn(db, { ...turn, phase: 'settled', outcome: 'silent', ended_at: 1790640001000 });
    expect(readSignals(capable).capabilities.stopTool).toBe(false);
  });

  it('projects independently measured model timing and validates its wire shape', () => {
    db.prepare('INSERT INTO turn_usage (id, turn_id, duration_ms, duration_api_ms) VALUES (?, ?, ?, ?)').run(
      'timing',
      turn.id,
      5000,
      1000,
    );
    const view = read();
    expect(view.turns[0].usage[0].value).toEqual({ duration_ms: 5000, duration_api_ms: 1000 });
    const frame = {
      kind: 'snapshot',
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      streamId: 'timing',
      revision: 0,
      conversation: view,
    };
    expect(parseConversationFrame(frame)).toBe(frame);
    view.turns[0].usage[0].value.duration_api_ms = -1;
    expect(() => parseConversationFrame(frame)).toThrow('invalid_frame');
  });
  it('keeps the first recorded position through tool lifecycle reduction and final output anchoring', () => {
    const step = (status: string) =>
      JSON.stringify({ kind: 'tool', id: 'tool', tool: 'Read', status, detail: 'file.txt' });
    db.prepare('INSERT INTO turn_activity (turn_id, ordinal, ts, text, timeline_position) VALUES (?, ?, ?, ?, ?)').run(
      turn.id,
      0,
      Number('1000'),
      step('running'),
      100,
    );
    db.prepare(
      'INSERT INTO turn_activity (turn_id, message_out_id, ordinal, ts, text, timeline_position) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(turn.id, 'out', 1, Number('999'), step('completed'), 300);
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied' });
    const view = read([{ ...output, timelinePosition: 200 }]);
    expect(view.turns[0].activity[0]).toMatchObject({ ordinal: 0, timelinePosition: 100, ts: 1000 });
    expect(view.timeline[0]).toMatchObject({ kind: 'message', messageId: 'out', trace: { ordinals: [0] } });
  });
  it('reduces tool state by identity while preserving emit order and unrecognized history', () => {
    const result = projectConversation(db, context, 't', 'g', [], {
      ...signals,
      activity: [
        {
          turnId: 'turn',
          ordinal: 0,
          timelinePosition: 100,
          ts: 1000,
          text: JSON.stringify({
            kind: 'tool',
            id: 'tool',
            tool: 'Read',
            status: 'running',
            detail: 'file.txt',
          }),
        },
        { turnId: 'turn', ordinal: 1, ts: 1001, text: 'Imported activity', timelinePosition: 200 },
        {
          turnId: 'turn',
          ordinal: 2,
          timelinePosition: 300,
          ts: 2000,
          text: JSON.stringify({
            kind: 'tool',
            id: 'tool',
            tool: 'Read',
            status: 'completed',
          }),
        },
      ],
    });
    expect(result.turns[0].activity).toHaveLength(2);
    expect(result.turns[0].activity[0].ordinal).toBe(0);
    expect(JSON.parse(result.turns[0].activity[0].text)).toMatchObject({
      status: 'completed',
      detail: 'file.txt',
      durationMs: 1000,
    });
    expect(result.turns[0].activity[1].text).toBe('Imported activity');
  });
  it('stages the response until the matching durable settlement and keeps live trace on reconnect', () => {
    const before = read([output, { ...output, id: 'update', deliveryOrigin: 'send_message' }]);
    expect(before.messages.map((m) => m.id)).toEqual(['update']);
    expect(before.turns[0].activity).toEqual([{ ordinal: 1, ts: 1, text: 'work', timelinePosition: 100 }]);
    expect(before.capabilities).toEqual({
      canSend: true,
      stop: true,
      stopTool: false,
      steer: true,
      editInput: true,
      cancelInput: true,
    });
    db.prepare(
      'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 100)',
    ).run('out', 1, Number('1'), 'durable', 'turn');
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', ended_at: 1790640002000 });
    const after = read([output]);
    expect(after.messages).toEqual([output]);
    expect(after.turns[0].activity[0].text).toBe('durable');
    expect(after.connection.activeTurnId).toBeNull();
    expect(after.capabilities.stop).toBe(false);
  });

  it('projects when the turn was requested, never before the previous turn ended', () => {
    const input = (id: string, timestamp: string): ConversationMessage => ({
      id,
      direction: 'in',
      timestamp: Date.parse(timestamp),
      text: id,
    });
    putTurn(db, { ...turn, id: 'earlier', started_at: 1790639990000, ended_at: 1790639998000 });
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', ended_at: 1790640002000 });
    linkTurnInput(db, { turn_id: 'turn', message_in_id: 'late', association: 'consumed' });
    linkTurnInput(db, { turn_id: 'turn', message_in_id: 'first', association: 'consumed' });
    const requested = (history: ConversationMessage[]) => read(history).turns.find((t) => t.id === 'turn')?.requestedAt;
    expect(requested([input('first', '2026-09-28T23:59:59Z'), input('late', '2026-09-29T00:00:00Z')])).toBe(
      Date.parse('2026-09-28T23:59:59.000Z'),
    );
    // Queued behind the earlier turn: the wait starts when that turn ended.
    expect(requested([input('first', '2026-09-28T23:59:55Z')])).toBe(Date.parse('2026-09-28T23:59:58.000Z'));
    expect(requested([])).toBeNull();
    const conversation = read([input('first', '2026-09-28T23:59:59Z')]);
    const frame = {
      kind: 'snapshot',
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      streamId: 'r',
      revision: 0,
      conversation,
    };
    expect(parseConversationFrame(frame)).toBe(frame);
  });

  it('omits a running turn’s checkpointed duration so the client shows live elapsed time', () => {
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'turn-metadata:turn',
      JSON.stringify({
        turnId: 'turn',
        durationMs: 1000,
        model: 'm',
        usageId: null,
        status: 'provisional',
        final: false,
      }),
      1767225600000,
    );
    expect(read().turns[0].metadata).toEqual({ status: 'provisional', model: 'm', durationMs: null });
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', ended_at: 1790640002000 });
    expect(read().turns[0].metadata).toEqual({ status: 'unavailable', model: 'm', durationMs: null });
    expect(read().turns[0].endedAt).toBe(Date.parse('2026-09-29T00:00:02.000Z'));
  });

  it.each(['silent', 'warning', 'interrupted', 'failed', 'stopped'] as const)(
    'retains outputless %s turns without inventing tokens',
    (outcome) => {
      putTurn(db, { ...turn, phase: 'settled', outcome });
      expect(read().turns[0]).toMatchObject({
        outcome,
        phase: 'settled',
        outputIds: [],
        usage: [],
        metadata: { status: 'unavailable' },
      });
    },
  );

  it('does not leak another route through an explicitly targeted outbound message', () => {
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', origin_thread_id: 'private' });
    const result = read([output]);
    expect(result.turns).toEqual([]);
    expect(result.messages[0]).not.toHaveProperty('turnId');
    expect(result.connection.activeTurnId).toBeNull();
  });

  it('restricts unknown imported turns to already-visible message anchors', () => {
    putTurn(db, {
      ...turn,
      phase: 'settled',
      outcome: 'unknown',
      provenance: 'backfill',
      origin_channel_type: null,
      origin_platform_id: null,
      origin_thread_id: null,
    });
    db.prepare(
      'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 100)',
    ).run('out', 0, Number('1'), 'visible', 'turn');
    db.prepare(
      'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 200)',
    ).run('private-out', 1, Number('2'), 'private', 'turn');
    db.prepare(
      'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 300)',
    ).run(null, 2, Number('3'), 'unanchored', 'turn');
    expect(read([output]).turns[0].activity.map((a) => a.text)).toEqual(['visible']);
    expect(read([]).turns).toEqual([]);
  });

  it('does not duplicate usage when one turn produces several responses', () => {
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied' });
    db.prepare(
      `INSERT INTO turn_usage
      (id, timestamp, turn_id, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      VALUES ('bill', 1767225600000, 'turn', 'model', 0.25, 20, 10, 0, 0)`,
    ).run();
    const result = read([output, { ...output, id: 'out-2' }]);
    expect(result.turns[0].outputIds).toEqual(['out', 'out-2']);
    expect(result.turns[0].usage).toHaveLength(1);
    expect(result.turns[0].usage[0]).toMatchObject({ id: 'bill', value: { cost_usd: 0.25 } });
  });

  it('disables controls on disconnect without erasing durable or live turn information', () => {
    const result = projectConversation(db, context, 't', 'g', [], {
      ...signals,
      active: { ...signals.active, connected: false },
    });
    expect(result.capabilities.stop).toBe(false);
    expect(result.turns[0].activity).toHaveLength(1);
    expect(result.turns[0].phase).toBe('running');
  });
});
