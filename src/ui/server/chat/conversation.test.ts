import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { linkTurnInput, putTurn, type TurnRow } from '../../../db/turns.js';
import { parseConversationFrame, reduceConversation } from '../../shared/conversation-protocol.js';
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
  activity: [{ turnId: 'turn', ordinal: 1, ts: '1', text: 'work', timelinePosition: 100 }],
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
  it('keeps the first recorded position through tool lifecycle reduction and final output anchoring', () => {
    const step = (status: string) =>
      JSON.stringify({ kind: 'tool', id: 'tool', tool: 'Read', status, detail: 'file.txt' });
    db.prepare('INSERT INTO turn_activity (turn_id, ordinal, ts, text, timeline_position) VALUES (?, ?, ?, ?, ?)').run(
      turn.id,
      0,
      '1000',
      step('running'),
      100,
    );
    db.prepare(
      'INSERT INTO turn_activity (turn_id, message_out_id, ordinal, ts, text, timeline_position) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(turn.id, 'out', 1, '999', step('completed'), 300);
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied' });
    const view = read([{ ...output, timelinePosition: 200 }]);
    expect(view.turns[0].activity[0]).toMatchObject({ ordinal: 0, timelinePosition: 100, ts: '1000' });
    expect(view.timeline[0]).toMatchObject({ kind: 'message', messageId: 'out', trace: { ordinals: [0] } });
  });
  it('reduces tool state by identity while preserving emit order and unrecognized history', () => {
    const result = projectConversation(db, context, 't', 'g', [], [], {
      ...signals,
      activity: [
        {
          turnId: 'turn',
          ordinal: 0,
          timelinePosition: 100,
          ts: '1000',
          text: JSON.stringify({
            kind: 'tool',
            id: 'tool',
            tool: 'Read',
            status: 'running',
            detail: 'file.txt',
          }),
        },
        { turnId: 'turn', ordinal: 1, ts: '1001', text: 'Imported activity', timelinePosition: 200 },
        {
          turnId: 'turn',
          ordinal: 2,
          timelinePosition: 300,
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

  describe('questions', () => {
    const question: Parameters<typeof projectConversation>[5][number] = {
      question_id: 'q',
      session_id: 's',
      message_out_id: 'question-output',
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
      created_at: '2026-09-29T00:00:01Z',
    };
    beforeEach(() => {
      db.prepare('INSERT INTO messages_out (id, kind, timestamp, content, turn_id) VALUES (?, ?, ?, ?, ?)').run(
        question.message_out_id,
        'system_action',
        question.created_at,
        '{}',
        turn.id,
      );
    });

    it('uses canonical turn ownership and scopes questions by channel, platform and thread', () => {
      db.prepare(
        'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 100)',
      ).run(question.message_out_id, 3, '1', 'question work', turn.id);
      const readQuestions = (status: typeof question.status) =>
        projectConversation(
          db,
          context,
          't',
          'g',
          [],
          [
            { ...question, status },
            { ...question, question_id: 'private', platform_id: 'private', message_out_id: 'missing-private-output' },
            {
              ...question,
              question_id: 'off-thread',
              thread_id: 'private-thread',
              message_out_id: 'missing-thread-output',
            },
            {
              ...question,
              question_id: 'off-channel',
              channel_type: 'telegram',
              message_out_id: 'missing-channel-output',
            },
          ],
          signals,
        );
      const pending = readQuestions('pending');
      expect(pending.questions).toHaveLength(1);
      expect(pending.timeline.find((row) => row.kind === 'turn')).toMatchObject({
        afterId: question.message_out_id,
      });
      const view = readQuestions('answered');
      expect(view.questions[0]).toMatchObject({ status: 'answered', turnId: turn.id });
      expect(view.questions[0]).not.toHaveProperty('activity');
      expect(view.turns).toHaveLength(1);
      expect(view.turns[0].activity.filter((line) => line.text === 'question work')).toHaveLength(1);
      expect(view.timeline.filter((row) => row.trace)).toHaveLength(1);
      expect(view.timeline.find((row) => row.kind === 'turn')).toMatchObject({
        afterId: question.message_out_id,
        trace: { turnId: turn.id, ownsTurn: true, ordinals: [1, 3] },
      });
      putTurn(db, { ...turn, origin_platform_id: 'private' });
      const privateOrigin = readQuestions('answered');
      expect(privateOrigin.questions[0]).not.toHaveProperty('turnId');
      expect(privateOrigin.turns).toHaveLength(0);
    });

    it('preserves the asked event and projects the answer as its own input event', () => {
      const base = Date.parse('2026-09-29T00:00:00Z') * 1000;
      db.prepare('UPDATE messages_out SET content = ? WHERE id = ?').run(
        JSON.stringify({ timelinePosition: base + 1_000_000 }),
        question.message_out_id,
      );
      putTurn(db, { ...turn, phase: 'settled', outcome: 'replied' });
      const reply = { ...output, timelinePosition: base + 2_000_000 };
      const readQuestion = (current: typeof question, inputs: ConversationMessage[] = []) =>
        projectConversation(db, context, 't', 'g', [reply, ...inputs], [current], signals);
      const pending = readQuestion({ ...question, created_at: '2026-09-29T00:00:10Z' });
      expect(pending.questions[0].timelinePosition).toBe(base + 1_000_000);
      expect(pending.timeline.map((row) => row.kind)).toEqual(['question', 'message']);

      const answered: typeof question = {
        ...question,
        status: 'answered',
        answer_value: 'Yes',
        answer_type: 'text',
        answered_at: '2026-09-29T00:00:03Z',
      };
      const queued = readQuestion(answered);
      expect(queued.questions[0].timelinePosition).toBe(pending.questions[0].timelinePosition);
      expect(queued.questions[0].createdAt).toBe(pending.questions[0].createdAt);
      expect(queued.timeline).toEqual(pending.timeline);

      const inputId = `question-response:${question.question_id}`;
      putTurn(db, { ...turn, id: 'answer-turn' });
      linkTurnInput(db, { turn_id: 'answer-turn', message_in_id: inputId, association: 'consumed' });
      const answerInput: ConversationMessage = {
        id: inputId,
        direction: 'in',
        questionId: question.question_id,
        text: 'Yes',
        timestamp: '2026-09-29T00:00:00Z',
        timelinePosition: base + 4_000_000,
      };
      const consumed = readQuestion(answered, [answerInput]);
      expect(consumed.questions[0]).toMatchObject({ timelinePosition: base + 1_000_000, turnId: turn.id });
      expect(consumed.messages.find((message) => message.id === inputId)).toEqual(answerInput);
      expect(consumed.turns.find((turn) => turn.id === 'answer-turn')?.inputIds).toEqual([inputId]);
      expect(consumed.timeline.map((row) => row.kind)).toEqual(['question', 'message', 'message', 'turn']);
      expect(consumed.timeline.slice(0, 2)).toEqual(pending.timeline);
      expect(consumed.timeline[3]).toMatchObject({
        turnId: 'answer-turn',
        afterId: inputId,
        trace: { turnId: 'answer-turn', ownsTurn: true },
      });
      expect(
        reduceConversation(
          null,
          parseConversationFrame({
            kind: 'snapshot',
            protocolVersion: 2,
            streamId: 'test',
            revision: 0,
            conversation: consumed,
          }),
        ).conversation,
      ).toEqual(consumed);
      expect(readQuestion(answered, [answerInput])).toEqual(consumed);
    });

    it('keeps a question-only asking turn before the answer and anchors the consuming turn after it', () => {
      const inputId = `question-response:${question.question_id}`;
      db.prepare('UPDATE messages_out SET content = ? WHERE id = ?').run(
        JSON.stringify({ timelinePosition: 200 }),
        question.message_out_id,
      );
      putTurn(db, { ...turn, phase: 'settled', outcome: 'silent' });
      linkTurnInput(db, { turn_id: turn.id, message_in_id: 'start', association: 'consumed' });
      putTurn(db, { ...turn, id: 'answer-turn' });
      linkTurnInput(db, { turn_id: 'answer-turn', message_in_id: inputId, association: 'consumed' });
      const view = projectConversation(
        db,
        context,
        't',
        'g',
        [
          {
            id: 'start',
            direction: 'in',
            text: 'Ask me',
            timestamp: 'invalid',
            timelinePosition: 100,
          },
          {
            id: inputId,
            direction: 'in',
            questionId: question.question_id,
            text: 'Yes',
            timestamp: 'invalid',
            timelinePosition: 300,
          },
        ],
        [
          {
            ...question,
            status: 'answered',
            answer_value: 'Yes',
            answer_type: 'text',
            answered_at: '2026-09-29T00:00:03Z',
          },
        ],
        signals,
      );
      expect(view.timeline).toMatchObject([
        { kind: 'message', messageId: 'start' },
        { kind: 'question', questionId: question.question_id },
        { kind: 'turn', turnId: turn.id, afterId: question.message_out_id, trace: { turnId: turn.id, ownsTurn: true } },
        { kind: 'message', messageId: inputId },
        {
          kind: 'turn',
          turnId: 'answer-turn',
          afterId: inputId,
          trace: { turnId: 'answer-turn', ownsTurn: true },
        },
      ]);
      expect(view.questions[0].turnId).toBe(turn.id);
      expect(view.messages).toHaveLength(2);
    });

    it('does not move asked events when question status changes', () => {
      db.prepare('UPDATE messages_out SET content = ? WHERE id = ?').run(
        JSON.stringify({ timelinePosition: 100 }),
        question.message_out_id,
      );
      for (const status of ['pending', 'answered', 'cancelled'] as const) {
        const view = projectConversation(db, context, 't', 'g', [], [{ ...question, status }], signals);
        expect(view.questions[0].timelinePosition).toBe(100);
        expect(view.turns[0].inputIds).toEqual([]);
      }
    });

    it.each(['missing output', 'missing output turn', 'missing turn record'])(
      'rejects a %s instead of normalizing history',
      (missing) => {
        if (missing === 'missing output') {
          db.prepare('DELETE FROM messages_out WHERE id = ?').run(question.message_out_id);
        } else {
          db.pragma('foreign_keys = OFF');
          db.prepare('UPDATE messages_out SET turn_id = ? WHERE id = ?').run(
            missing === 'missing output turn' ? null : 'missing-turn',
            question.message_out_id,
          );
        }
        db.prepare(
          'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 100)',
        ).run(question.message_out_id, 3, '1', 'old activity', missing === 'missing output' ? turn.id : null);
        expect(() => projectConversation(db, context, 't', 'g', [], [question], signals)).toThrow(
          'Missing conversation question turn association',
        );
      },
    );
  });
  it('stages the response until the matching durable settlement and keeps live trace on reconnect', () => {
    const before = read([output, { ...output, id: 'update', deliveryOrigin: 'send_message' }]);
    expect(before.messages.map((m) => m.id)).toEqual(['update']);
    expect(before.turns[0].activity).toEqual([{ ordinal: 1, ts: '1', text: 'work', timelinePosition: 100 }]);
    expect(before.capabilities).toEqual({ canSend: true, stop: true, steer: true, editInput: true, cancelInput: true });
    db.prepare(
      'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 100)',
    ).run('out', 1, '1', 'durable', 'turn');
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', ended_at: '2026-09-29T00:00:02Z' });
    const after = read([output]);
    expect(after.messages).toEqual([output]);
    expect(after.turns[0].activity[0].text).toBe('durable');
    expect(after.connection.activeTurnId).toBeNull();
    expect(after.capabilities.stop).toBe(false);
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
      'now',
    );
    expect(read().turns[0].metadata).toEqual({ status: 'provisional', model: 'm', durationMs: null });
    putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', ended_at: '2026-09-29T00:00:02Z' });
    expect(read().turns[0].metadata.durationMs).toBe(1000);
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
    ).run('out', 0, '1', 'visible', 'turn');
    db.prepare(
      'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 200)',
    ).run('private-out', 1, '2', 'private', 'turn');
    db.prepare(
      'INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position) VALUES (?, ?, ?, ?, ?, 300)',
    ).run(null, 2, '3', 'unanchored', 'turn');
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
