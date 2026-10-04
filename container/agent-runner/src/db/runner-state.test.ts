import { afterEach, describe, expect, it } from 'bun:test';

import {
  clearContainerToolInFlight,
  closeSessionDb,
  getOutboundDb,
  initTestSessionDb,
  setContainerToolInFlight,
} from './connection.js';
import { markCompleted, markProcessing } from './messages-in.js';
import { setContinuation } from './session-state.js';
import { startTaskAttempt, recordTaskScriptResult } from './task-attempts.js';
import { writeTurnActivity } from './turn-activity.js';
import { writeTurnCheckpoint } from './turn-checkpoints.js';
import { writeTurnUsage } from './turn-usage.js';
import { ensureRunnerStateSchema } from './runner-state.js';
import { beginTurn } from '../turn-execution.js';
import { Database } from 'bun:sqlite';

afterEach(() => closeSessionDb());

describe('runner state journal', () => {
  it('rejects unmigrated activity storage without changing it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE turn_activity (
        message_out_id TEXT, ordinal INTEGER, ts TEXT, text TEXT, turn_id TEXT,
        PRIMARY KEY (message_out_id, ordinal));
        INSERT INTO turn_activity VALUES ('legacy', 0, 'same-time', 'work', NULL)`);
      expect(() => ensureRunnerStateSchema(db)).toThrow('Unsupported activity-order schema');
      expect(db.prepare('PRAGMA table_info(turn_activity)').all()).toHaveLength(5);
    } finally { db.close(); }
  });
  it('journals a durable turn identity, and reopening the schema is a no-op', () => {
    initTestSessionDb();
    const db = getOutboundDb();
    const turn = beginTurn({ channelType: 'web', platformId: 'chat', threadId: null, inReplyTo: null }, []);
    const row = db.prepare("SELECT payload FROM pending_runner_events WHERE event_type='turn.upsert'").get() as { payload: string };
    expect(JSON.parse(row.payload).id).toBe(turn.turnId);
    const events = db.prepare('SELECT COUNT(*) AS n FROM pending_runner_events').get();
    ensureRunnerStateSchema(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_runner_events').get()).toEqual(events);
  });
  it('journals every durable runner-owned table mutation in order', () => {
    initTestSessionDb();
    const db = getOutboundDb();
    db.prepare(
      `INSERT INTO messages_out
        (id, seq, timestamp, kind, content)
       VALUES ('out-1', 1, datetime('now'), 'chat', '{"text":"hello"}')`,
    ).run();
    markProcessing(['in-1']);
    markCompleted(['in-1']);
    setContinuation('native', 'continuation-1');
    setContainerToolInFlight('Bash', 1000);
    clearContainerToolInFlight();
    writeTurnCheckpoint('out-1', 'native', 'continuation-1', 'turn-1');
    writeTurnActivity('out-1', [{ ts: '1', text: '{"kind":"notification","id":"n1","text":"ok"}', timelinePosition: 1 }]);
    writeTurnUsage('usage-1', 'out-1', {
      cost_usd: 0.1,
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'test/model',
    });
    startTaskAttempt({
      id: 'task-1',
      seq: 2,
      kind: 'task',
      timestamp: '2026-09-01T00:00:00.000Z',
      status: 'pending',
      process_after: null,
      recurrence: null,
      series_id: 'series-1',
      tries: 0,
      trigger: 1,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      content: '{"triggerSource":"manual"}',
    });
    recordTaskScriptResult('task-1', {
      status: 'skipped',
      durationMs: 1,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      error: null,
      wakeAgent: false,
    });

    const rows = db
      .prepare('SELECT sequence, event_type, payload FROM pending_runner_events ORDER BY sequence')
      .all() as Array<{ sequence: number; event_type: string; payload: string }>;
    expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index + 1));
    expect(rows.map((row) => row.event_type)).toEqual([
      'message.upsert',
      'processing.upsert',
      'processing.upsert',
      'state.upsert',
      'container.upsert',
      'container.upsert',
      'checkpoint.upsert',
      'activity.persist',
      'usage.persist',
      'task-attempt.upsert',
      'task-attempt.upsert',
    ]);
    for (const row of rows) expect(() => JSON.parse(row.payload)).not.toThrow();
  });

  it('rejects oversized state and clamps declared tool timeouts before journaling', () => {
    initTestSessionDb();
    const db = getOutboundDb();

    expect(() => setContinuation('native', 'x'.repeat(1024 * 1024 + 1))).toThrow(
      'session state exceeds durable link limits',
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM pending_runner_events WHERE event_type = 'state.upsert'").get()).toEqual({
      count: 0,
    });

    setContainerToolInFlight('Bash', Number.MAX_SAFE_INTEGER);
    const payload = db
      .prepare("SELECT payload FROM pending_runner_events WHERE event_type = 'container.upsert'")
      .get() as { payload: string };
    expect(JSON.parse(payload.payload).tool_declared_timeout_ms).toBe(6 * 60 * 60 * 1000);
  });
});
