import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CENTRAL_SCHEMA_SQL } from '../src/db/central-schema.js';
import { createTarget, dropTriggers, put, rows, type Row, type Store } from './migrate-reply-suggestions-db.js';
import { migrateReplySuggestions, parseArgs } from './migrate-reply-suggestions.js';

const USER = '00000000-0000-4000-8000-000000000001';
const TIME = 1700000000000;
const ROOT = path.resolve(import.meta.dirname, '..', `.reply-migration-fixtures-${process.pid}`);
const SESSION = 'data/v2-sessions/group/session';
const INPUT_KEY = `input:${crypto.createHash('sha256').update('question-response:q').digest('hex')}`;
let source: string;
let output: string;
let fixtureNumber = 0;

function location(root: string, store: Store): string {
  return path.join(
    root,
    store === 'central'
      ? 'data/v2.db'
      : `${SESSION}/${store === 'runner' ? 'runner-state/runner-state.db' : `${store}.db`}`,
  );
}

function edit(store: Store, apply: (db: Database.Database) => void, root = source): void {
  const db = new Database(location(root, store));
  try {
    dropTriggers(db);
    apply(db);
  } finally {
    db.close();
  }
}

function read(store: Store, table: string, root = output): Row[] {
  const db = new Database(location(root, store), { readonly: true });
  try {
    return rows(db, table);
  } finally {
    db.close();
  }
}

function run(candidate = output) {
  return migrateReplySuggestions({
    sourceRoot: source,
    outputRoot: candidate,
    hostStopped: true,
    runnersStopped: true,
  });
}

function inbound(overrides: Row = {}): Row {
  return {
    id: 'question-response:q',
    seq: 4,
    kind: 'interactive_response',
    timestamp: TIME + 10,
    status: 'processing',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 2,
    trigger: 1,
    platform_id: 'room',
    channel_type: 'web',
    thread_id: 'thread',
    content: JSON.stringify({
      type: 'question_response',
      questionId: 'q',
      question: 'Which environment?',
      responseType: 'choice',
      value: 'prod-value',
      userId: USER,
    }),
    source_session_id: null,
    on_wake: 0,
    sender_user_id: USER,
    sender_identity: 'web:operator',
    ...overrides,
  };
}

function outbound(overrides: Row = {}): Row {
  return {
    id: 'out-q',
    seq: 3,
    in_reply_to: 'initial',
    timestamp: TIME,
    deliver_after: null,
    recurrence: null,
    kind: 'chat',
    platform_id: 'room',
    channel_type: 'web',
    thread_id: 'thread',
    turn_id: null,
    content: JSON.stringify({
      type: 'ask_question',
      questionId: 'q',
      question: 'Which environment?',
      options: [{ label: 'Production', selectedLabel: 'Selected production', value: 'prod-value' }],
      responseMode: 'choice',
      timelinePosition: 19,
    }),
    ...overrides,
  };
}

function question(overrides: Row = {}): Row {
  return {
    id: 'q',
    kind: 'question',
    session_id: 'session',
    agent_group_id: 'group',
    origin_message_id: 'initial',
    request_id: null,
    message_out_id: 'out-q',
    in_reply_to: 'initial',
    platform_id: 'room',
    channel_type: 'web',
    thread_id: 'thread',
    input_json: JSON.stringify({
      question: 'Which environment?',
      responseMode: 'choice',
      options: [{ label: 'Production', selectedLabel: 'Selected production', value: 'prod-value' }],
    }),
    response_json: JSON.stringify({ responseType: 'choice', value: 'prod-value' }),
    status: 'answered',
    revision: 2,
    created_at: TIME,
    updated_at: TIME + 10,
    dedupe_key: null,
    responded_by: USER,
    responded_at: TIME + 10,
    outcome_message: null,
    resolved_at: TIME + 10,
    route_origin_id: null,
    ...overrides,
  };
}

function approval(): Row {
  return {
    ...question(),
    id: 'approval',
    kind: 'confirmation',
    request_id: 'request',
    message_out_id: null,
    in_reply_to: null,
    input_json: '{"title":"Approve?"}',
    response_json: '{"type":"fixture","payload":{}}',
    status: 'approved',
  };
}

function fixture(): void {
  fs.mkdirSync(source, { recursive: true });
  const legacyCentral = CENTRAL_SCHEMA_SQL.replace(
    "kind IN ('confirmation','account_setup','access_grant')",
    "kind IN ('question','confirmation','account_setup','access_grant')",
  )
    .replace("kind IN ('message','approval')", "kind IN ('message','question','approval')")
    .replace('  request_id TEXT,\n', '  request_id TEXT,\n  message_out_id TEXT,\n  in_reply_to TEXT,\n')
    .replace(
      '(request_id IS NOT NULL AND response_json IS NOT NULL',
      `(kind='question' AND session_id IS NOT NULL AND message_out_id IS NOT NULL
      AND status IN ('pending','answered','cancelled')
      AND ((status='answered' AND response_json IS NOT NULL AND responded_at IS NOT NULL)
        OR (status!='answered' AND response_json IS NULL)))
    OR (kind!='question' AND request_id IS NOT NULL AND response_json IS NOT NULL`,
    );
  for (const store of ['central', 'inbound', 'outbound', 'runner'] as const) {
    const db = store === 'central' ? new Database(':memory:') : createTarget(store);
    if (store === 'central') db.exec(legacyCentral);
    dropTriggers(db);
    db.pragma('user_version=1');
    if (store === 'central') {
      put(db, 'users', {
        id: USER,
        kind: 'human',
        display_name: 'Operator',
        created_at: TIME,
        onboarded_at: null,
        unread_baseline: 11,
      });
      put(db, 'agent_groups', {
        id: 'group',
        name: 'Group',
        folder: 'group',
        agent_provider: 'claude',
        created_at: TIME,
        site_slug: null,
        site_enabled: 0,
        email_slug: null,
        email_enabled: 0,
      });
      db.prepare(
        `INSERT INTO sessions(id,agent_group_id,status,container_status,created_at)
        VALUES ('session','group','active','stopped',?)`,
      ).run(TIME);
      put(db, 'interactions', question());
      put(db, 'interactions', approval());
      put(db, 'conversation_publications', {
        position: 17,
        key: 'stable-question-key',
        session_id: 'session',
        kind: 'question',
        item_id: 'q',
        channel_type: 'web',
        platform_id: 'room',
        thread_id: 'thread',
        visible: 1,
      });
      put(db, 'conversation_reads', {
        user_id: USER,
        session_id: 'session',
        channel_type: 'web',
        platform_id: 'room',
        thread_id: 'thread',
        position: 15,
      });
      put(db, 'thread_summary_meta', { id: 1, ready: 1, unread_ready: 1 });
    }
    if (store === 'inbound' || store === 'runner') put(db, 'messages_in', inbound());
    if (store === 'outbound' || store === 'runner') {
      put(db, 'messages_out', outbound());
      put(db, 'processing_ack', { message_id: 'question-response:q', status: 'processing', status_changed: TIME + 12 });
      put(db, 'session_state', {
        key: INPUT_KEY,
        value: '{"messageId":"question-response:q","status":"applied","timelinePosition":20}',
        updated_at: TIME + 12,
      });
    }
    if (store === 'inbound') {
      put(db, 'host_sequence', { id: 1, last_even: 4 });
      put(db, 'delivered', {
        message_out_id: 'out-q',
        platform_message_id: 'receipt',
        status: 'delivered',
        delivered_at: TIME + 1,
      });
    }
    if (store === 'runner') {
      put(db, 'host_state', { key: 'sequence_floor', value: '4' });
      put(db, 'timeline_clock', { id: 1, position: 20 });
      put(db, 'claimed_inputs', { message_id: 'question-response:q' });
    }
    const file = location(source, store);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, db.serialize());
    db.close();
  }
  fs.mkdirSync(path.join(source, 'groups/group'), { recursive: true });
  fs.writeFileSync(path.join(source, 'groups/group/CLAUDE.md'), 'Fixture personality.\n');
}

function queue(store: 'inbound' | 'runner', type: string, payload: unknown, sequence = 1, id = `${store}-event`): void {
  edit(store, (db) =>
    put(db, store === 'inbound' ? 'pending_host_events' : 'pending_runner_events', {
      sequence,
      event_id: id,
      event_type: type,
      payload: JSON.stringify(payload),
      created_at: TIME + 30,
    }),
  );
}

function hostPayload(row: Row): Row {
  const { content, ...payload } = row;
  payload.content_hex = Buffer.from(String(content)).toString('hex').toUpperCase();
  payload.timestamp = new Date(Number(payload.timestamp)).toISOString();
  return payload;
}

function wire(row: Row): Row {
  return { ...row, timestamp: new Date(Number(row.timestamp)).toISOString() };
}

beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  source = path.join(ROOT, `source-${++fixtureNumber}`);
  output = path.join(ROOT, `candidate-${fixtureNumber}`);
  fixture();
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('offline candidate reply-suggestions migration', () => {
  it('hydrates explicitly approved host snapshots across journal gaps without reusing clocks', () => {
    queue('inbound', 'message.upsert', hostPayload(inbound()), 10, 'host-gap');
    edit('inbound', (db) => {
      db.prepare("UPDATE sqlite_sequence SET seq=20 WHERE name='pending_host_events'").run();
    });
    edit('runner', (db) => {
      put(
        db,
        'messages_out',
        outbound({
          id: 'retired-internal',
          seq: 9,
          kind: 'internal',
          content: '{"text":"Historical internal trace","timelinePosition":30}',
        }),
      );
    });
    expect(() => run(path.join(ROOT, 'strict-gap'))).toThrow('out-of-order durable event');
    const manifest = migrateReplySuggestions({
      sourceRoot: source,
      outputRoot: output,
      hostStopped: true,
      runnersStopped: true,
      canonicalHostProjection: true,
    });
    expect(manifest.projectionAuthority).toBe('host');
    expect(manifest.events.map((event) => event.id)).toContain('host-gap');
    expect(read('runner', 'applied_host_events')[0].last_sequence).toBe(20);
    expect(read('inbound', 'host_sequence')[0].last_even).toBeGreaterThanOrEqual(10);
    expect(read('runner', 'messages_out').map((row) => row.id)).toEqual(['out-q']);
    expect(read('runner', 'messages_out')).toEqual(read('outbound', 'messages_out'));
  });

  it('never discards unmatched runner conversation outputs under host projection authority', () => {
    edit('runner', (db) =>
      put(
        db,
        'messages_out',
        outbound({
          id: 'unprojected-chat',
          seq: 9,
          content: '{"text":"Keep this conversation reply","timelinePosition":30}',
        }),
      ),
    );
    expect(() =>
      migrateReplySuggestions({
        sourceRoot: source,
        outputRoot: output,
        hostStopped: true,
        runnersStopped: true,
        canonicalHostProjection: true,
      }),
    ).toThrow('cannot discard runner-only conversation');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('retains host-authored even outbound sequences while converting historical questions', () => {
    for (const store of ['outbound', 'runner'] as const)
      edit(store, (db) =>
        put(
          db,
          'messages_out',
          outbound({
            id: 'bounce-a2a-history',
            seq: 12,
            content: '{"text":"A host-authored delivery notice","timelinePosition":30}',
          }),
        ),
      );
    edit('runner', (db) => db.prepare('UPDATE timeline_clock SET position=30 WHERE id=1').run());
    run();
    expect(read('outbound', 'messages_out').find((row) => row.id === 'bounce-a2a-history')?.seq).toBe(12);
    expect(read('runner', 'messages_out')).toEqual(read('outbound', 'messages_out'));
  });

  it('preserves old question output context after its lifecycle row was retired', () => {
    edit('central', (db) => {
      db.exec(
        "DELETE FROM conversation_publications WHERE kind='question'; DELETE FROM interactions WHERE kind='question'",
      );
    });
    const manifest = run();
    expect(manifest.counts.historicalQuestionContexts).toBe(1);
    expect(String(read('outbound', 'messages_out')[0].content)).toContain('Which environment?');
    expect(String(read('inbound', 'messages_in')[0].content)).toContain('Selected production');
    expect(read('central', 'interactions')).toHaveLength(1);
  });

  it('runs the actual explicit CLI without service/env bootstrap', () => {
    fs.writeFileSync(path.join(source, '.env'), 'invalid bootstrap sentinel\n');
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, '../node_modules/tsx/dist/cli.mjs'),
        path.resolve(import.meta.dirname, 'migrate-reply-suggestions.ts'),
        '--source-root',
        source,
        '--output-root',
        output,
        '--host-stopped',
        '--runners-stopped',
      ],
      { cwd: source, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified private candidate only');
    expect(fs.existsSync(path.join(output, 'candidate-manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(source, '.env'), 'utf8')).toBe('invalid bootstrap sentinel\n');
    expect(fs.existsSync(path.join(output, '.env'))).toBe(false);
  });

  it('uses fresh v2 schemas, preserves both projections, receipts, input states and unread positions', () => {
    const before = crypto
      .createHash('sha256')
      .update(fs.readFileSync(location(source, 'central')))
      .digest('hex');
    const manifest = run();
    expect(manifest.counts).toMatchObject({ questions: 1, sessions: 1, inputs: 1, outputs: 1 });
    expect(manifest.stores).toHaveLength(4);
    for (const [relative, checksum] of Object.entries(manifest.sourceFiles)) {
      expect(
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(source, relative)))
          .digest('hex'),
      ).toBe(checksum);
    }
    for (const [relative, checksum] of Object.entries(manifest.candidateFiles)) {
      expect(
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(output, relative)))
          .digest('hex'),
      ).toBe(checksum);
    }
    expect(manifest.sourceFiles['data/v2.db']).toBe(before);
    expect(
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(location(source, 'central')))
        .digest('hex'),
    ).toBe(before);
    expect(fs.statSync(output).mode & 0o777).toBe(0o700);
    for (const store of ['central', 'inbound', 'outbound', 'runner'] as const) {
      const db = new Database(location(output, store), { readonly: true });
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      if (store === 'central') {
        const columns = db.prepare('PRAGMA table_info(interactions)').all() as { name: string }[];
        expect(columns.map((column) => column.name)).not.toContain('message_out_id');
        expect(columns.map((column) => column.name)).not.toContain('in_reply_to');
        const mutable = new Database(db.serialize());
        expect(() => mutable.prepare("UPDATE interactions SET kind='question'").run()).toThrow('CHECK constraint');
        expect(() => mutable.prepare("UPDATE conversation_publications SET kind='question'").run()).toThrow(
          'CHECK constraint',
        );
        mutable.close();
      }
      for (const table of db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]) {
        expect(JSON.stringify(rows(db, table.name))).not.toMatch(
          /ask_question|question_response|interactive_response|ask_user_question/,
        );
      }
      db.close();
    }
    expect(read('central', 'interactions')).toEqual([expect.objectContaining({ id: 'approval', status: 'approved' })]);
    expect(read('central', 'conversation_publications')).toEqual([
      expect.objectContaining({
        position: 17,
        key: 'stable-question-key',
        kind: 'message',
        item_id: 'out-q',
        visible: 1,
      }),
    ]);
    expect(read('central', 'conversation_reads')[0].position).toBe(15);
    expect(read('central', 'users')[0].unread_baseline).toBe(11);
    expect(read('central', 'thread_summary_meta')[0]).toEqual({ id: 1, ready: 0, unread_ready: 1 });
    const outputContent = JSON.parse(String(read('outbound', 'messages_out')[0].content));
    expect(outputContent).toEqual({
      text: 'Which environment?\n- Production',
      delivery_origin: 'send_message',
      timelinePosition: 19,
    });
    const inputRow = read('inbound', 'messages_in')[0];
    expect(inputRow).toMatchObject({
      id: 'question-response:q',
      seq: 4,
      kind: 'chat',
      status: 'processing',
      tries: 2,
      timestamp: TIME + 10,
      sender_user_id: USER,
    });
    expect(JSON.parse(String(inputRow.content))).toEqual({
      text: '> Which environment?\n\nSelected production (recorded value: "prod-value")',
      sender: 'Operator',
      sender_id: 'web:operator',
    });
    expect(read('runner', 'messages_in')).toEqual(read('inbound', 'messages_in'));
    expect(read('runner', 'messages_out')).toEqual(read('outbound', 'messages_out'));
    expect(read('runner', 'session_state')).toEqual(read('outbound', 'session_state'));
    expect(read('runner', 'claimed_inputs')).toEqual([{ message_id: 'question-response:q' }]);
    expect(read('inbound', 'delivered')[0]).toMatchObject({ platform_message_id: 'receipt', delivered_at: TIME + 1 });
    expect(read('runner', 'session_state').some((row) => String(row.key).includes('suggestion'))).toBe(false);
  });

  it.each(['pending', 'cancelled'])('preserves %s state as static prose without fabricating a reply', (status) => {
    edit('central', (db) =>
      put(db, 'interactions', question({ status, response_json: null, responded_by: null, responded_at: null })),
    );
    for (const store of ['inbound', 'runner'] as const) edit(store, (db) => db.exec('DELETE FROM messages_in'));
    for (const store of ['outbound', 'runner'] as const) edit(store, (db) => db.exec('DELETE FROM session_state'));
    run();
    expect(read('inbound', 'messages_in')).toEqual([]);
    expect(String(read('outbound', 'messages_out')[0].content)).toContain(status);
  });

  it('preserves explicit skipped semantics and hidden publication positions', () => {
    edit('central', (db) => {
      put(db, 'interactions', question({ response_json: '{"responseType":"skipped"}' }));
      db.exec('UPDATE conversation_publications SET visible=0');
    });

    const skipped = inbound({
      content: JSON.stringify({
        type: 'question_response',
        questionId: 'q',
        question: 'Which environment?',
        responseType: 'skipped',
        userId: USER,
      }),
    });
    for (const store of ['inbound', 'runner'] as const) edit(store, (db) => put(db, 'messages_in', skipped));
    run();
    expect(JSON.parse(String(read('inbound', 'messages_in')[0].content)).text).toContain('explicitly skipped');
    expect(read('central', 'conversation_publications')[0]).toMatchObject({ visible: 0, position: 17 });
  });

  it.each(['pending', 'processed', 'completed', 'failed', 'paused'])(
    'retains %s input status and scheduling fields',
    (status) => {
      const original = inbound({ status, trigger: 0, on_wake: 1, process_after: TIME + 9000 });
      for (const store of ['inbound', 'runner'] as const) edit(store, (db) => put(db, 'messages_in', original));
      run();
      expect(read('inbound', 'messages_in')[0]).toMatchObject({
        id: original.id,
        seq: original.seq,
        status,
        trigger: 0,
        on_wake: 1,
        process_after: TIME + 9000,
        timestamp: TIME + 10,
        tries: 2,
      });
      expect(read('runner', 'messages_in')).toEqual(read('inbound', 'messages_in'));
    },
  );

  it('refuses escaped executable JSON artifacts and unknown external search databases', () => {
    fs.writeFileSync(path.join(source, 'groups/group/provider-history.json'), '{"type":"\\u0061sk_question"}');
    expect(() => run()).toThrow('opaque artifact');
    expect(fs.existsSync(output)).toBe(false);
    fs.unlinkSync(path.join(source, 'groups/group/provider-history.json'));
    fs.writeFileSync(path.join(source, 'data/search.db'), 'fixture');
    expect(() => run()).toThrow('unknown data database search.db');
  });

  it('reconciles pending host/runner events, retaining event IDs and clocks without redelivery', () => {
    edit('runner', (db) => db.exec('DELETE FROM messages_in; DELETE FROM messages_out'));
    edit('outbound', (db) => db.exec('DELETE FROM messages_out'));
    queue('inbound', 'message.upsert', hostPayload(inbound()));
    queue('runner', 'message.upsert', wire(outbound()));
    queue('runner', 'batch.persisted', {}, 2, 'barrier');
    edit('runner', (db) => put(db, 'messages_out', outbound()));
    const manifest = run();
    expect(manifest.events.map((event) => event.id)).toEqual(['inbound-event', 'runner-event', 'barrier']);
    expect(read('inbound', 'pending_host_events')).toEqual([]);
    expect(read('runner', 'pending_runner_events')).toEqual([]);
    expect(read('runner', 'applied_host_events')[0].last_sequence).toBe(1);
    expect(read('outbound', 'applied_runner_events').map((row) => row.sequence)).toEqual([1, 2]);
    expect(read('inbound', 'delivered')).toHaveLength(1);
    const db = new Database(location(output, 'runner'));
    expect(rows(db, 'sqlite_sequence').find((row) => row.name === 'pending_runner_events')?.seq).toBe(2);
    db.close();
  });

  it('projects processing and input state events while preserving store-local acknowledgement dates', () => {
    edit('runner', (db) => {
      put(db, 'processing_ack', { message_id: 'question-response:q', status: 'completed', status_changed: TIME + 21 });
      put(db, 'session_state', {
        key: INPUT_KEY,
        value: '{"messageId":"question-response:q","status":"queued","timelinePosition":20}',
        updated_at: TIME + 22,
      });
    });
    queue('runner', 'processing.upsert', {
      message_id: 'question-response:q',
      status: 'completed',
      status_changed: new Date(TIME + 21).toISOString(),
    });
    queue(
      'runner',
      'state.upsert',
      {
        key: INPUT_KEY,
        value: '{"messageId":"question-response:q","status":"queued","timelinePosition":20}',
        updated_at: new Date(TIME + 22).toISOString(),
      },
      2,
      'input-state',
    );
    run();
    expect(read('outbound', 'processing_ack')[0]).toMatchObject({ status: 'completed', status_changed: TIME + 21 });
    expect(read('runner', 'session_state')).toEqual(read('outbound', 'session_state'));
    const retry = path.join(ROOT, 'local-receipt-times');
    edit('outbound', (db) => db.prepare('UPDATE processing_ack SET status_changed=?').run(TIME + 15), output);
    migrateReplySuggestions({ sourceRoot: output, outputRoot: retry, hostStopped: true, runnersStopped: true });
    expect(read('outbound', 'processing_ack', retry)[0].status_changed).toBe(TIME + 15);
    expect(read('runner', 'processing_ack', retry)[0].status_changed).toBe(TIME + 21);
  });

  it('retains settled turn references and refuses unsettled turns and regressed timeline clocks', () => {
    const turn: Row = {
      id: 'turn',
      origin_channel_type: 'web',
      origin_platform_id: 'room',
      origin_thread_id: 'thread',
      origin_source_session_id: null,
      started_at: TIME - 10,
      ended_at: TIME + 1,
      phase: 'settled',
      outcome: 'replied',
      provenance: 'native',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    };
    for (const store of ['outbound', 'runner'] as const)
      edit(store, (db) => {
        put(db, 'turns', turn);
        put(db, 'turn_inputs', { turn_id: 'turn', message_in_id: 'question-response:q', association: 'reply' });
        db.exec("UPDATE messages_out SET turn_id='turn'");
      });
    run();
    expect(read('outbound', 'messages_out')[0].turn_id).toBe('turn');
    expect(read('runner', 'turn_inputs')).toEqual(read('outbound', 'turn_inputs'));
    for (const store of ['outbound', 'runner'] as const)
      edit(store, (db) => db.exec("UPDATE turns SET phase='running'"));
    expect(() => run(path.join(ROOT, 'unsettled'))).toThrow('unsettled turn');
    for (const store of ['outbound', 'runner'] as const)
      edit(store, (db) => db.exec("UPDATE turns SET phase='settled'"));
    edit('runner', (db) => db.exec('UPDATE timeline_clock SET position=1'));
    expect(() => run(path.join(ROOT, 'regressed'))).toThrow('timeline clock is missing/regressed');
  });

  it('accepts exact acknowledged replay but rejects conflicting receipts', () => {
    const payload = wire(outbound());
    queue('runner', 'message.upsert', payload);
    const digest = crypto
      .createHash('sha256')
      .update(JSON.stringify({ type: 'message.upsert', payload }))
      .digest('hex');
    edit('outbound', (db) =>
      put(db, 'applied_runner_events', {
        event_id: 'runner-event',
        sequence: 1,
        event_type: 'message.upsert',
        event_digest: digest,
        applied_at: TIME,
      }),
    );
    run();
    expect(read('outbound', 'applied_runner_events')[0].event_digest).toBe(digest);
    edit('outbound', (db) => db.exec("UPDATE applied_runner_events SET event_digest='conflict'"));
    expect(() => run(path.join(ROOT, 'conflict'))).toThrow('conflicting durable event replay');
    expect(fs.existsSync(path.join(ROOT, 'conflict'))).toBe(false);
  });

  it.each([
    ['runner', 'turn.upsert', { id: 'turn' }, 'unsupported unacknowledged runner'],
    [
      'runner',
      'state.upsert',
      { key: 'input-edit:answer', value: '{}', updated_at: new Date(TIME).toISOString() },
      'unsupported unacknowledged state',
    ],
    [
      'inbound',
      'routing.upsert',
      { channel_type: 'web', platform_id: 'room', thread_id: 'thread' },
      'unsupported unacknowledged host',
    ],
  ] as const)('refuses unsafe %s queue %s before creating output', (store, type, payload, error) => {
    queue(store, type, payload);
    expect(() => run()).toThrow(error);
    expect(fs.existsSync(output)).toBe(false);
    expect(read(store, store === 'runner' ? 'pending_runner_events' : 'pending_host_events', source)).toHaveLength(1);
  });

  it('rejects sequence gaps and projection divergence', () => {
    queue('inbound', 'message.upsert', hostPayload(inbound()), 3);
    expect(() => run()).toThrow('out-of-order durable event');
    edit('inbound', (db) => db.exec('DELETE FROM pending_host_events'));
    edit('runner', (db) => db.exec("UPDATE messages_in SET status='failed'"));
    expect(() => run()).toThrow('projections have not converged');
  });

  it('fails rather than fabricating missing or conflicting answered-question evidence', () => {
    for (const store of ['inbound', 'runner'] as const) edit(store, (db) => db.exec('DELETE FROM messages_in'));
    for (const store of ['outbound', 'runner'] as const) edit(store, (db) => db.exec('DELETE FROM session_state'));
    expect(() => run()).toThrow('lacks deterministic inbound evidence');
    expect(read('central', 'interactions', source).filter((row) => row.kind === 'question')).toHaveLength(1);
  });

  it('refuses publication collisions instead of changing unread boundaries', () => {
    edit('central', (db) =>
      put(db, 'conversation_publications', {
        position: 18,
        key: 'collision',
        session_id: 'session',
        kind: 'message',
        item_id: 'out-q',
        channel_type: 'web',
        platform_id: 'room',
        thread_id: 'thread',
        visible: 1,
      }),
    );
    expect(() => run()).toThrow('publication position collision');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('migrates approval requests and system results without changing options/status/result', () => {
    const approvalOutput = outbound({
      id: 'out-approval',
      seq: 5,
      content: JSON.stringify({
        type: 'ask_question',
        questionId: 'approval',
        title: 'Approve?',
        question: 'Install package?',
        options: [{ label: 'Yes', selectedLabel: 'Approved', value: 'approve' }],
      }),
    });
    const systemInput = inbound({
      id: 'system-result',
      seq: 6,
      kind: 'system',
      timestamp: TIME + 11,
      content: '{"type":"question_response","questionId":"request","status":"approved","result":{"ok":true}}',
    });
    for (const store of ['outbound', 'runner'] as const) edit(store, (db) => put(db, 'messages_out', approvalOutput));
    for (const store of ['inbound', 'runner'] as const) edit(store, (db) => put(db, 'messages_in', systemInput));
    edit('inbound', (db) => put(db, 'host_sequence', { id: 1, last_even: 6 }));
    edit('runner', (db) => put(db, 'host_state', { key: 'sequence_floor', value: '6' }));
    run();
    expect(
      JSON.parse(String(read('outbound', 'messages_out').find((row) => row.id === 'out-approval')?.content)),
    ).toEqual({
      type: 'approval_request',
      approvalId: 'approval',
      title: 'Approve?',
      body: 'Install package?',
      options: [{ label: 'Yes', selectedLabel: 'Approved', value: 'approve' }],
    });
    expect(
      JSON.parse(String(read('inbound', 'messages_in').find((row) => row.id === 'system-result')?.content)),
    ).toEqual({
      type: 'system_response',
      requestId: 'request',
      status: 'approved',
      result: { ok: true },
    });
  });

  it('retries in a different new candidate idempotently and leaves undelivered output eligible', () => {
    edit('inbound', (db) => db.exec('DELETE FROM delivered'));
    run();
    const first = read('outbound', 'messages_out');
    const second = path.join(ROOT, 'retry');
    run(second);
    expect(read('outbound', 'messages_out', second)).toEqual(first);
    expect(read('inbound', 'delivered')).toEqual([]);
    expect(() => run()).toThrow('NEW and nonexistent');
    const third = path.join(ROOT, 'v2-retry');
    migrateReplySuggestions({ sourceRoot: output, outputRoot: third, hostStopped: true, runnersStopped: true });
    expect(read('outbound', 'messages_out', third)).toEqual(first);
  });

  it('migrates complete archive interaction dumps AND both archived session trees to v4', () => {
    const dump = {
      version: 3,
      archived_at: new Date(TIME).toISOString(),
      archived_by: { user_id: USER },
      agent_group: read('central', 'agent_groups', source)[0],
      container_config: null,
      sessions: read('central', 'sessions', source),
      interactions: read('central', 'interactions', source),
      messaging_group_agents: [],
      agent_group_members: [],
      user_roles: [],
      agent_destinations_owned: [],
      agent_destinations_pointing: [],
      pending_sender_approvals: [],
      pending_channel_approvals: [],
    };
    edit('central', (db) =>
      db.exec(
        'DELETE FROM interactions; DELETE FROM conversation_reads; DELETE FROM conversation_publications; DELETE FROM sessions; DELETE FROM agent_groups',
      ),
    );
    fs.renameSync(path.join(source, 'groups/group'), path.join(source, 'groups/group~'));
    fs.renameSync(path.join(source, 'data/v2-sessions/group'), path.join(source, 'data/v2-sessions/group~'));
    const archivePath = 'groups/group~/archive.json';
    fs.writeFileSync(path.join(source, archivePath), JSON.stringify(dump));
    const manifest = run();
    expect(manifest.counts).toMatchObject({ archives: 1, sessions: 1, questions: 1 });
    const archived = JSON.parse(fs.readFileSync(path.join(output, archivePath), 'utf8'));
    expect(archived.version).toBe(4);
    expect(archived.interactions).toEqual([expect.objectContaining({ id: 'approval' })]);
    expect(archived.interactions[0]).not.toHaveProperty('message_out_id');
    for (const relative of ['inbound.db', 'outbound.db', 'runner-state/runner-state.db']) {
      const db = new Database(path.join(output, 'data/v2-sessions/group~/session', relative), { readonly: true });
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      const contents = rows(db, relative === 'inbound.db' ? 'messages_in' : 'messages_out');
      expect(JSON.stringify(contents)).not.toContain('ask_question');
      db.close();
    }
    expect(JSON.parse(fs.readFileSync(path.join(source, archivePath), 'utf8')).version).toBe(3);
  });

  it('rejects incomplete old archives and uninventoried session trees', () => {
    fs.writeFileSync(path.join(source, 'groups/group/archive.json'), '{"version":3,"sessions":[]}');
    expect(() => run()).toThrow('omitted messaging_group_agents');
    fs.unlinkSync(path.join(source, 'groups/group/archive.json'));
    fs.mkdirSync(path.join(source, 'data/v2-sessions/orphan'), { recursive: true });
    fs.copyFileSync(location(source, 'inbound'), path.join(source, 'data/v2-sessions/orphan/inbound.db'));
    expect(() => run()).toThrow('uninventoried/provider-native database');
  });

  it('preserves safe native storage at v1 byte-for-byte and rejects executable legacy history', () => {
    const relative = `${SESSION}/native-state/native-state.db`;
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    const db = new Database(path.join(source, relative));
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES conversations(id),
        content_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE applied_steering(conversation_id TEXT NOT NULL,steering_id TEXT NOT NULL,message_id INTEGER NOT NULL,
        PRIMARY KEY(conversation_id,steering_id));
      CREATE TABLE context_compactions(conversation_id TEXT PRIMARY KEY,through_id INTEGER NOT NULL,summary TEXT NOT NULL,retained_ids TEXT NOT NULL);
      CREATE TABLE finished_turns(conversation_id TEXT NOT NULL,first_id INTEGER NOT NULL,last_id INTEGER NOT NULL,
        PRIMARY KEY(conversation_id,first_id));
      CREATE TABLE media_quarantines(conversation_id TEXT NOT NULL,provider_scope TEXT NOT NULL,media_key TEXT NOT NULL,
        confirmed_ref INTEGER NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(conversation_id,provider_scope,media_key));
      CREATE TABLE tool_results(id TEXT PRIMARY KEY,content_json TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.prepare('INSERT INTO conversations VALUES(?,?,?)').run('native-conversation', TIME, TIME);
    db.prepare('INSERT INTO messages(conversation_id,content_json,created_at) VALUES(?,?,?)').run(
      'native-conversation',
      '{"role":"user","content":"Historical chat"}',
      TIME,
    );
    db.close();
    const manifest = run();
    expect(fs.readFileSync(path.join(output, relative))).toEqual(fs.readFileSync(path.join(source, relative)));
    expect(manifest.nativeStorageVersion).toBe(1);
    expect(manifest.stores.find((store) => store.store === 'native')).toMatchObject({
      sourceVersion: 1,
      targetVersion: 1,
    });
    const unsafe = new Database(path.join(source, relative));
    unsafe
      .prepare('UPDATE messages SET content_json=?')
      .run('{"role":"assistant","content":[{"type":"tool-call","toolName":"ask_user_question"}]}');
    unsafe.close();
    expect(() => run(path.join(ROOT, 'native-unsafe'))).toThrow('native history requires structural conversion');
  });

  it('requires explicit stopped confirmations and refuses nested/equal/live roots, symlinks and sidecars', () => {
    expect(() => parseArgs(['--source-root', source, '--output-root', output, '--install'])).toThrow(
      'no install/force',
    );
    expect(() =>
      migrateReplySuggestions({ sourceRoot: source, outputRoot: output, hostStopped: true, runnersStopped: false }),
    ).toThrow('both');
    for (const candidate of [source, path.join(source, 'child'), ROOT]) {
      expect(() => run(candidate)).toThrow('equal or nested');
    }
    expect(() =>
      migrateReplySuggestions({
        sourceRoot: path.resolve(import.meta.dirname, '..', 'data'),
        outputRoot: output,
        hostStopped: true,
        runnersStopped: true,
      }),
    ).toThrow('live data/groups are forbidden');
    const link = path.join(ROOT, 'link');
    fs.symlinkSync(source, link);
    expect(() =>
      migrateReplySuggestions({ sourceRoot: link, outputRoot: output, hostStopped: true, runnersStopped: true }),
    ).toThrow('symlink path component');
    fs.symlinkSync(location(source, 'inbound'), path.join(source, 'groups/group/escape'));
    expect(() => run()).toThrow('symlink path component');
    fs.unlinkSync(path.join(source, 'groups/group/escape'));
    const alternateData = path.join(ROOT, 'alternate-data');
    fs.renameSync(path.join(source, 'data'), alternateData);
    fs.symlinkSync(alternateData, path.join(source, 'data'));
    expect(() => run()).toThrow('symlink path component');
    fs.unlinkSync(path.join(source, 'data'));
    fs.renameSync(alternateData, path.join(source, 'data'));
    fs.writeFileSync(location(source, 'central') + '-wal', '');
    // Sidecars adjacent to v2.db are checked before opening SQLite.
    expect(() => run()).toThrow('sidecar');
  });
});
