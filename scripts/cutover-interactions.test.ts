import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { cutoverInteractions } from './cutover-interactions.js';
import { migrations, runMigrations } from '../src/db/migrations/index.js';
import { migration049 } from '../src/db/migrations/049-interactions.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'backup'), { mode: 0o700 });
  const options = {
    db: path.join(root, 'v2.db'),
    sessions: path.join(root, 'sessions'),
    backup: path.join(root, 'backup', 'original.db'),
    offline: true,
  };
  const db = new Database(options.db);
  db.pragma('foreign_keys=ON');
  runMigrations(
    db,
    migrations.filter((m) => m !== migration049),
  );
  db.exec(`
    INSERT INTO schema_version(version,name,applied) SELECT MAX(version)+1,'retained-approvals','original' FROM schema_version;
    CREATE TABLE questions(
      question_id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),message_out_id TEXT,in_reply_to TEXT,
      platform_id TEXT,channel_type TEXT,thread_id TEXT,question_text TEXT,response_mode TEXT,options_json TEXT,
      status TEXT,answer_value TEXT,answer_type TEXT,answered_by TEXT,answered_at TEXT,cancelled_at TEXT,created_at TEXT);
    CREATE TABLE approvals(
      approval_id TEXT PRIMARY KEY,kind TEXT,session_id TEXT REFERENCES sessions(id),agent_group_id TEXT REFERENCES agent_groups(id),
      origin_message_id TEXT,request_id TEXT,action TEXT,payload TEXT,title TEXT,options_json TEXT,status TEXT,revision INTEGER,
      dedupe_key TEXT,decision TEXT,responded_by TEXT,response_message TEXT,outcome_message TEXT,
      created_at TEXT,updated_at TEXT,expires_at TEXT,resolved_at TEXT);
    CREATE TABLE approval_workflows(approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),data_json TEXT,
      submission_ids_json TEXT,restart INTEGER,notified INTEGER);
  `);
  const specs = new Map<string, unknown>();
  const button = { label: 'Yes', selectedLabel: 'Agreed', value: 'yes' };
  for (let i = 0; i < 9; i++)
    db.prepare('INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)').run(
      `g${i}`,
      `Group ${i}`,
      `group${i}`,
      'created',
    );
  for (let i = 0; i < 42; i++) {
    const id = `q${i}`,
      session = `s${i}`,
      group = `g${i % 9}`,
      answered = i < 32,
      tag = i % 3 === 0 ? 'skipped' : i % 3 === 1 ? 'text' : 'choice';
    const spec = {
      type: 'ask_question',
      questionId: id,
      question: `Question ${i}`,
      responseMode: 'choice_or_text',
      options: [button],
      placeholder: `Hint ${i}`,
      multiline: i % 2 === 0,
    };
    specs.set(id, spec);
    db.prepare(
      "INSERT INTO sessions(id,agent_group_id,container_status,created_at) VALUES(?,?,'stopped','created')",
    ).run(session, group);
    const dir = path.join(options.sessions, group, session);
    fs.mkdirSync(dir, { recursive: true });
    const out = new Database(path.join(dir, 'outbound.db'));
    out.exec(`CREATE TABLE turns(id TEXT PRIMARY KEY);
      INSERT INTO turns VALUES('turn');
      CREATE TABLE messages_out(id TEXT PRIMARY KEY,content TEXT,turn_id TEXT,in_reply_to TEXT,platform_id TEXT,channel_type TEXT,thread_id TEXT);`);
    out
      .prepare("INSERT INTO messages_out VALUES('out',?,'turn',NULL,'web-group','web','thread')")
      .run(JSON.stringify(spec));
    out.close();
    db.prepare(
      "INSERT INTO questions VALUES(?,?, 'out',NULL,'web-group','web','thread',?,'choice_or_text',?,?,?,?,?, ?,NULL,'created')",
    ).run(
      id,
      session,
      spec.question,
      JSON.stringify([button]),
      answered ? 'answered' : 'pending',
      answered && tag !== 'skipped' ? 'yes' : null,
      answered ? tag : null,
      answered ? `actor${i}` : null,
      answered ? 'answered' : null,
    );
  }
  const insert =
    db.prepare(`INSERT INTO approvals VALUES(?,?,'s0','g0','origin',?,'request_access',?,'Review','[]',?,7,?,?,?,
    'Keep existing work.',?,'created','updated','expires',?)`);
  insert.run(
    'setup',
    'account_setup',
    'original-request',
    JSON.stringify({ resource_url: 'https://example.test/', reason: 'Need access', scopes: ['read'] }),
    'pending',
    'dedupe',
    null,
    null,
    null,
    null,
  );
  for (const id of ['approved1', 'approved2']) {
    insert.run(id, 'confirmation', id, '{}', 'approved', null, 'approve', 'owner', 'Applied', 'resolved');
    db.prepare("UPDATE approvals SET action='install_packages' WHERE approval_id=?").run(id);
  }
  const privateData =
    '{"selection":{"connectionId":"private-id","requestRevision":7},"attempt_history":[{"status":"failed","selection":{"connection_revision":4}}]}';
  db.prepare('INSERT INTO approval_workflows VALUES(?,?,?,?,?)').run(
    'setup',
    privateData,
    '["alias-1","alias-2"]',
    1,
    1,
  );
  const questions = db.prepare('SELECT * FROM questions ORDER BY question_id').all();
  const approvals = db.prepare('SELECT * FROM approvals ORDER BY approval_id').all();
  const progress = db.prepare('SELECT * FROM approval_workflows').all();
  db.close();
  return { options, specs, questions, approvals, progress, privateData };
}

it.each(['DELETE', 'WAL'])(
  'preserves a synthetic 42-question / 3-approval / 9-group inventory in %s mode, full inputs and private progress',
  async (mode) => {
    const f = fixture();
    const source = new Database(f.options.db);
    source.pragma(`journal_mode=${mode}`);
    source.close();
    await cutoverInteractions(f.options);
    const db = new Database(f.options.db);
    try {
      expect(db.prepare('SELECT COUNT(*) n FROM agent_groups').get()).toEqual({ n: 9 });
      expect(
        db.prepare('SELECT kind,status,COUNT(*) n FROM interactions GROUP BY kind,status ORDER BY kind,status').all(),
      ).toEqual([
        { kind: 'account_setup', status: 'pending', n: 1 },
        { kind: 'confirmation', status: 'approved', n: 2 },
        { kind: 'question', status: 'answered', n: 32 },
        { kind: 'question', status: 'pending', n: 10 },
      ]);
      for (const old of f.questions as Record<string, unknown>[]) {
        const current = db.prepare('SELECT * FROM interactions WHERE id=?').get(old.question_id) as Record<
          string,
          unknown
        >;
        const {
          type: _type,
          questionId: _id,
          ...spec
        } = f.specs.get(String(old.question_id)) as Record<string, unknown>;
        expect(JSON.parse(String(current.input_json))).toEqual(spec);
        for (const key of [
          'session_id',
          'message_out_id',
          'in_reply_to',
          'platform_id',
          'channel_type',
          'thread_id',
          'status',
          'created_at',
        ])
          expect(current[key]).toEqual(old[key]);
        expect(current.responded_by).toBe(old.answered_by);
        expect(current.responded_at).toBe(old.answered_at);
        expect(current.response_json && JSON.parse(String(current.response_json))).toEqual(
          old.status !== 'answered'
            ? null
            : old.answer_type === 'skipped'
              ? { responseType: 'skipped' }
              : { responseType: old.answer_type, value: old.answer_value },
        );
      }
      for (const old of f.approvals as Record<string, unknown>[]) {
        const current = db.prepare('SELECT * FROM interactions WHERE id=?').get(old.approval_id) as Record<
          string,
          unknown
        >;
        expect(JSON.parse(String(current.input_json))).toEqual({
          action: old.action,
          payload: JSON.parse(String(old.payload)),
          title: old.title,
          options: JSON.parse(String(old.options_json)),
        });
        expect(JSON.parse(String(current.response_json))).toEqual({
          decision: old.decision,
          message: old.response_message,
        });
        for (const key of [
          'kind',
          'session_id',
          'agent_group_id',
          'origin_message_id',
          'request_id',
          'created_at',
          'updated_at',
          'expires_at',
          'status',
          'revision',
          'dedupe_key',
          'responded_by',
          'outcome_message',
          'resolved_at',
        ])
          expect(current[key]).toEqual(old[key]);
      }
      expect(db.prepare('SELECT * FROM interaction_progress').all()).toEqual(
        f.progress.map((row) => {
          const { approval_id, ...rest } = row as Record<string, unknown>;
          return { id: approval_id, ...rest };
        }),
      );
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name IN ('questions','approvals','approval_workflows')").all(),
      ).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      runMigrations(db);
      expect(db.prepare('SELECT COUNT(*) n FROM interactions').get()).toEqual({ n: 45 });
    } finally {
      db.close();
    }
    expect(fs.statSync(f.options.backup).mode & 0o777).toBe(0o600);
    const backup = new Database(f.options.backup, { readonly: true });
    try {
      expect(backup.prepare('SELECT * FROM questions ORDER BY question_id').all()).toEqual(f.questions);
      expect(backup.prepare('SELECT * FROM approvals ORDER BY approval_id').all()).toEqual(f.approvals);
      expect(backup.prepare('SELECT * FROM approval_workflows').all()).toEqual(f.progress);
    } finally {
      backup.close();
    }
  },
);

it('preserves multiple retained pending questions in one session without cancelling either', async () => {
  const f = fixture();
  const db = new Database(f.options.db);
  db.exec("UPDATE questions SET session_id='s40',message_out_id='out41' WHERE question_id='q41'");
  db.close();
  const out = new Database(path.join(f.options.sessions, 'g4', 's40', 'outbound.db'));
  out
    .prepare("INSERT INTO messages_out VALUES('out41',?,'turn',NULL,'web-group','web','thread')")
    .run(JSON.stringify(f.specs.get('q41')));
  out.close();
  await cutoverInteractions(f.options);
  const result = new Database(f.options.db);
  try {
    expect(result.prepare("SELECT id,status FROM interactions WHERE session_id='s40' ORDER BY id").all()).toEqual([
      { id: 'q40', status: 'pending' },
      { id: 'q41', status: 'pending' },
    ]);
  } finally {
    result.close();
  }
});

it.each([true, false])(
  'converts title-based legacy prompts only when the retained title matches (%s)',
  async (matches) => {
    const f = fixture();
    const source = new Database(f.options.db);
    source.prepare("UPDATE questions SET response_mode='choice' WHERE question_id='q32'").run();
    source.close();
    const out = new Database(path.join(f.options.sessions, 'g5', 's32', 'outbound.db'));
    const original = JSON.stringify({
      type: 'ask_question',
      questionId: 'q32',
      title: matches ? 'Question 32' : 'Unrelated title',
      question: 'The full legacy question, not its short title.',
      options: [{ label: 'Yes', selectedLabel: 'Agreed', value: 'yes' }],
      placeholder: 'Retained hint',
      multiline: false,
    });
    out.prepare('UPDATE messages_out SET content=?').run(original);
    out.close();
    if (matches) {
      await cutoverInteractions(f.options);
      const result = new Database(f.options.db);
      try {
        const row = result.prepare("SELECT input_json,status FROM interactions WHERE id='q32'").get() as {
          input_json: string;
          status: string;
        };
        expect(row.status).toBe('pending');
        expect(JSON.parse(row.input_json)).toEqual({
          question: 'The full legacy question, not its short title.',
          responseMode: 'choice',
          options: [{ label: 'Yes', selectedLabel: 'Agreed', value: 'yes' }],
          placeholder: 'Retained hint',
          multiline: false,
        });
      } finally {
        result.close();
      }
    } else {
      await expect(cutoverInteractions(f.options)).rejects.toThrow('Invalid question provenance');
    }
    const unchanged = new Database(path.join(f.options.sessions, 'g5', 's32', 'outbound.db'), { readonly: true });
    try {
      expect(unchanged.prepare('SELECT content FROM messages_out').get()).toEqual({ content: original });
    } finally {
      unchanged.close();
    }
  },
);

it.each([
  'applying',
  'running',
  'collision',
  'alias collision',
  'invalid input',
  'missing provenance',
  'invalid answer',
  'foreign key',
  'no offline',
  'socket',
  'existing backup',
  'locked',
  'unrecognized state',
  'invalid progress',
])('refuses %s without dropping, resetting or partially converting records', async (failure) => {
  const f = fixture(),
    db = new Database(f.options.db);
  if (failure === 'applying') db.exec("UPDATE approvals SET status='applying' WHERE approval_id='setup'");
  if (failure === 'running') db.exec("UPDATE sessions SET container_status='running' WHERE id='s0'");
  if (failure === 'collision') db.exec("UPDATE questions SET question_id='approved1' WHERE question_id='q0'");
  if (failure === 'alias collision') db.exec(`UPDATE approval_workflows SET submission_ids_json='["q0"]'`);
  if (failure === 'invalid answer') db.exec("UPDATE questions SET answer_type=NULL WHERE question_id='q0'");
  if (failure === 'foreign key') {
    db.pragma('foreign_keys=OFF');
    db.exec("UPDATE questions SET session_id='missing' WHERE question_id='q0'");
  }
  if (failure === 'no offline') f.options.offline = false;
  if (failure === 'socket') fs.writeFileSync(path.join(path.dirname(f.options.db), 'ncl.sock'), 'offline guard');
  if (failure === 'existing backup') fs.writeFileSync(f.options.backup, 'do not replace');
  if (failure === 'missing provenance') fs.unlinkSync(path.join(f.options.sessions, 'g0', 's0', 'outbound.db'));
  if (failure === 'invalid input') {
    const out = new Database(path.join(f.options.sessions, 'g0', 's0', 'outbound.db'));
    out.exec(
      `UPDATE messages_out SET content='{"type":"ask_question","questionId":"q0","question":"Question 0","responseMode":"choice_or_text","options":[],"placeholder":42}'`,
    );
    out.close();
  }
  if (failure === 'unrecognized state') db.exec('ALTER TABLE questions ADD COLUMN unrecognized TEXT');
  if (failure === 'invalid progress') db.exec("UPDATE approval_workflows SET data_json='invalid'");
  const before = {
    questions: db.prepare('SELECT * FROM questions').all(),
    approvals: db.prepare('SELECT * FROM approvals').all(),
    progress: db.prepare('SELECT * FROM approval_workflows').all(),
    versions: db.prepare('SELECT * FROM schema_version').all(),
  };
  if (failure === 'locked') db.exec('BEGIN EXCLUSIVE');
  try {
    await expect(cutoverInteractions(f.options)).rejects.toThrow();
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
  }
  expect(db.prepare('SELECT * FROM questions').all()).toEqual(before.questions);
  expect(db.prepare('SELECT * FROM approvals').all()).toEqual(before.approvals);
  expect(db.prepare('SELECT * FROM approval_workflows').all()).toEqual(before.progress);
  expect(db.prepare('SELECT * FROM schema_version').all()).toEqual(before.versions);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='interactions'").get()).toBeUndefined();
  db.close();
});
