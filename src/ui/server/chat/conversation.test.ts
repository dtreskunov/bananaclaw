import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { putTurn, type TurnRow } from '../../../db/turns.js';
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
  started_at: '2026-09-29T00:00:00Z',
  ended_at: null,
  imported_from_session_id: null,
  imported_from_turn_id: null,
};
const output: ConversationMessage = {
  id: 'out',
  direction: 'out',
  timestamp: '2026-09-29T00:00:01Z',
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
  activity: [{ turnId: 'turn', ordinal: 1, ts: '1', text: 'work' }],
  usage: null,
};
const read = (history: ConversationMessage[] = []) => projectConversation(db, context, 't', 'g', history, [], signals);
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(OUTBOUND_SCHEMA);
  putTurn(db, turn);
});
afterEach(() => db.close());

describe('authoritative conversation projection', () => {
  it('reduces tool state by identity while preserving emit order and unrecognized history', () => {
    const result = projectConversation(db, context, 't', 'g', [], [], {
      ...signals,
      activity: [
        {
          turnId: 'turn',
          ordinal: 0,
          ts: '1000',
          text: JSON.stringify({
            kind: 'tool',
            id: 'tool',
            tool: 'Read',
            status: 'running',
            detail: 'file.txt',
          }),
        },
        { turnId: 'turn', ordinal: 1, ts: '1001', text: 'Imported activity' },
        {
          turnId: 'turn',
          ordinal: 2,
          ts: '2000',
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

  it('scopes questions by platform as well as thread and preserves unassociated historical traces', () => {
    const question: Parameters<typeof projectConversation>[5][number] = {
      question_id: 'q',
      session_id: 's',
      message_out_id: 'legacy-question',
      in_reply_to: null,
      channel_type: 'web',
      platform_id: 'group:g',
      thread_id: 't',
      title: 'Question',
      question_text: 'Choose?',
      response_mode: 'text',
      options_json: '[]',
      status: 'pending',
      answer_value: null,
      answer_type: null,
      answered_by: null,
      answered_at: null,
      cancelled_at: null,
      created_at: 'now',
    };
    db.prepare('INSERT INTO turn_activity VALUES (?, ?, ?, ?, ?)').run('legacy-question', 0, '1', 'legacy', null);
    const readQuestions = (status: typeof question.status) =>
      projectConversation(
        db,
        context,
        't',
        'g',
        [],
        [
          { ...question, status },
          { ...question, question_id: 'private', platform_id: 'private' },
        ],
        signals,
      );
    expect(readQuestions('pending').questions).toHaveLength(1);
    expect(readQuestions('answered').questions[0]).toMatchObject({
      status: 'answered',
      activity: [{ ts: '1', text: 'legacy' }],
    });
  });
  it('stages the response until the matching durable settlement and keeps live trace on reconnect', () => {
    const before = read([output, { ...output, id: 'update', deliveryOrigin: 'send_message' }]);
    expect(before.messages.map((m) => m.id)).toEqual(['update']);
    expect(before.turns[0].activity).toEqual([{ ordinal: 1, ts: '1', text: 'work' }]);
    expect(before.capabilities).toEqual({ canSend: true, stop: true, steer: true, editInput: true, cancelInput: true });
    db.prepare('INSERT INTO turn_activity VALUES (?, ?, ?, ?, ?)').run('out', 1, '1', 'durable', 'turn');
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', ended_at: '2026-09-29T00:00:02Z' });
    const after = read([output]);
    expect(after.messages).toEqual([output]);
    expect(after.turns[0].activity[0].text).toBe('durable');
    expect(after.connection.activeTurnId).toBeNull();
    expect(after.capabilities.stop).toBe(false);
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
        liveUsage: null,
        metadata: { status: 'unavailable' },
      });
    },
  );

  it('does not leak another route through an explicitly targeted outbound message', () => {
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', origin_thread_id: 'private' });
    const result = read([
      {
        ...output,
        usage: {
          cost_usd: 1,
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          model: 'secret',
        },
        activity: [{ ts: '1', text: 'private' }],
      },
    ]);
    expect(result.turns).toEqual([]);
    expect(result.messages[0]).not.toHaveProperty('turnId');
    expect(result.messages[0]).not.toHaveProperty('usage');
    expect(result.messages[0]).not.toHaveProperty('activity');
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
    db.prepare('INSERT INTO turn_activity VALUES (?, ?, ?, ?, ?)').run('out', 0, '1', 'visible', 'turn');
    db.prepare('INSERT INTO turn_activity VALUES (?, ?, ?, ?, ?)').run('private-out', 1, '2', 'private', 'turn');
    db.prepare('INSERT INTO turn_activity VALUES (?, ?, ?, ?, ?)').run(null, 2, '3', 'unanchored', 'turn');
    expect(read([output]).turns[0].activity.map((a) => a.text)).toEqual(['visible']);
    expect(read([]).turns).toEqual([]);
  });

  it('does not duplicate usage when one turn produces several responses', () => {
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied' });
    db.prepare(
      `INSERT INTO turn_usage
      (id, timestamp, turn_id, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
      VALUES ('bill', 'now', 'turn', 'model', 0.25, 20, 10, 0, 0)`,
    ).run();
    const result = read([output, { ...output, id: 'out-2' }]);
    expect(result.turns[0].outputIds).toEqual(['out', 'out-2']);
    expect(result.turns[0].usage).toHaveLength(1);
    expect(result.turns[0].usage[0]).toMatchObject({ id: 'bill', value: { cost_usd: 0.25 } });
  });

  it('disables controls on disconnect without erasing durable or live turn information', () => {
    const result = projectConversation(db, context, 't', 'g', [], [], {
      ...signals,
      active: { ...signals.active, connected: false },
    });
    expect(result.capabilities.stop).toBe(false);
    expect(result.turns[0].activity).toHaveLength(1);
    expect(result.turns[0].phase).toBe('running');
  });
});
