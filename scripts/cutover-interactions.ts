/**
 * Disposable, offline-only conversion of the retained-approvals schema.
 * Never imported by the host. See docs/user-requests-refactor-plan.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { INTERACTION_SCHEMA, migration049 } from '../src/db/migrations/049-interactions.js';
import { isQuestionInput, isQuestionResponse } from '../src/ui/shared/conversation-protocol.js';
import { accessRequestInput, objectBody } from '../src/ui/shared/connection-input.js';
import type { QuestionInput } from '../src/ui/shared/question.js';

interface LegacyQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  in_reply_to: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  question_text: string;
  response_mode: QuestionInput['responseMode'];
  options_json: string;
  status: string;
  answer_value: string | null;
  answer_type: string | null;
  answered_by: string | null;
  answered_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}
interface LegacyApproval {
  approval_id: string;
  kind: string;
  action: string;
  payload: string;
  title: string;
  options_json: string;
  decision: string | null;
  response_message: string | null;
  [key: string]: unknown;
}

function check(db: Database.Database): void {
  const violations = db.pragma('foreign_key_check') as object[];
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || violations.length)
    throw new Error('Database integrity or foreign-key check failed; source was not converted.');
}

function questionInput(db: Database.Database, root: string, q: LegacyQuestion): QuestionInput {
  const session = db.prepare('SELECT agent_group_id FROM sessions WHERE id=?').get(q.session_id) as
    | { agent_group_id: string }
    | undefined;
  if (!session) throw new Error(`Missing session for question ${q.question_id}`);
  const file = path.resolve(root, session.agent_group_id, q.session_id, 'outbound.db');
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Invalid session path');
  const out = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const anchor = out.prepare('SELECT * FROM messages_out WHERE id=?').get(q.message_out_id) as
      | {
          content: string;
          turn_id: string;
          in_reply_to: string | null;
          platform_id: string | null;
          channel_type: string | null;
          thread_id: string | null;
        }
      | undefined;
    if (!anchor || !out.prepare('SELECT 1 FROM turns WHERE id=?').get(anchor.turn_id))
      throw new Error(`Missing question provenance: ${q.question_id}`);
    const original = objectBody(JSON.parse(anchor.content));
    const legacyTitle = original.responseMode === undefined && original.title === q.question_text;
    const input = legacyTitle ? { ...original, responseMode: q.response_mode } : original;
    if (
      !isQuestionInput(input) ||
      !('type' in input) ||
      input.type !== 'ask_question' ||
      !('questionId' in input) ||
      input.questionId !== q.question_id ||
      (!legacyTitle && input.question !== q.question_text) ||
      input.responseMode !== q.response_mode ||
      !isDeepStrictEqual(input.options, JSON.parse(q.options_json)) ||
      ['in_reply_to', 'platform_id', 'channel_type', 'thread_id'].some(
        (key) => anchor[key as keyof typeof anchor] !== q[key as keyof LegacyQuestion],
      )
    )
      throw new Error(`Invalid question provenance: ${q.question_id}`);
    const { question, responseMode, options, placeholder, multiline } = input;
    return {
      question,
      responseMode,
      options,
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(multiline === undefined ? {} : { multiline }),
    };
  } finally {
    out.close();
  }
}

export async function cutoverInteractions(options: {
  db: string;
  sessions: string;
  backup: string;
  offline: boolean;
}): Promise<void> {
  if (!options.offline) throw new Error('Stop the host and all containers, disable restart, then supply --offline.');
  if (fs.existsSync(path.join(path.dirname(options.db), 'ncl.sock')))
    throw new Error('Host socket exists; establish offline quiescence before cutover.');
  if (
    path.resolve(options.db) === path.resolve(options.backup) ||
    (fs.statSync(path.dirname(options.backup)).mode & 0o077) !== 0
  )
    throw new Error('Use a new backup file in an operator-owned mode-0700 directory.');
  const db = new Database(options.db, { fileMustExist: true, timeout: 0 });
  db.pragma('foreign_keys=ON');
  try {
    db.exec('BEGIN IMMEDIATE');
    check(db);
    if (
      !db.prepare("SELECT 1 FROM schema_version WHERE name='retained-approvals'").get() ||
      !db.prepare("SELECT 1 FROM schema_version WHERE name='agent-vault-only'").get() ||
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='interactions'").get()
    )
      throw new Error('Only the reviewed retained-approvals / Agent Vault-only schema is supported.');
    const columns = {
      questions:
        'question_id session_id message_out_id in_reply_to platform_id channel_type thread_id question_text response_mode options_json status answer_value answer_type answered_by answered_at cancelled_at created_at',
      approvals:
        'approval_id kind session_id agent_group_id origin_message_id request_id action payload title options_json created_at expires_at status revision updated_at dedupe_key decision responded_by response_message outcome_message resolved_at',
      approval_workflows: 'approval_id data_json submission_ids_json restart notified',
    };
    for (const [table, names] of Object.entries(columns)) {
      const actual = (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name).sort();
      if (!isDeepStrictEqual(actual, names.split(' ').sort()))
        throw new Error(`Unsupported ${table} columns; refusing to discard unrecognized state.`);
    }
    if (
      db.prepare("SELECT 1 FROM sessions WHERE container_status IS NOT 'stopped'").get() ||
      db.prepare("SELECT 1 FROM approvals WHERE status='applying'").get()
    )
      throw new Error('Active containers or uncertain applying effects require offline operator review.');
    const backupFd = fs.openSync(options.backup, 'wx', 0o600);
    fs.closeSync(backupFd);
    const snapshot = new Database(options.db, { readonly: true, fileMustExist: true });
    try {
      await snapshot.backup(options.backup);
    } finally {
      snapshot.close();
    }
    fs.chmodSync(options.backup, 0o600);
    const backup = new Database(options.backup, { readonly: true, fileMustExist: true });
    try {
      check(backup);
    } finally {
      backup.close();
    }
    const questions = db.prepare('SELECT * FROM questions').all() as LegacyQuestion[];
    const approvals = db.prepare('SELECT * FROM approvals').all() as LegacyApproval[];
    const identities = new Map<string, string>();
    const claim = (id: string, owner: string) => {
      if (identities.has(id) && identities.get(id) !== owner) throw new Error(`Global interaction ID collision: ${id}`);
      identities.set(id, owner);
    };
    for (const q of questions) claim(q.question_id, `question:${q.question_id}`);
    for (const a of approvals) claim(a.approval_id, `approval:${a.approval_id}`);
    const progress = db.prepare('SELECT * FROM approval_workflows').all() as {
      approval_id: string;
      submission_ids_json: string;
      data_json: string;
      restart: number;
      notified: number;
    }[];
    for (const row of progress) {
      objectBody(JSON.parse(row.data_json));
      if (![0, 1].includes(row.restart) || ![0, 1].includes(row.notified))
        throw new Error(`Invalid private progress flags for ${row.approval_id}`);
      const aliases: unknown = JSON.parse(row.submission_ids_json);
      if (!Array.isArray(aliases) || aliases.some((id) => typeof id !== 'string' || !id))
        throw new Error(`Invalid submission aliases for ${row.approval_id}`);
      for (const id of aliases) claim(id, `approval:${row.approval_id}`);
    }
    db.exec(INTERACTION_SCHEMA);
    const insert = (record: Record<string, unknown>) => {
      const keys = Object.keys(record);
      db.prepare(`INSERT INTO interactions(${keys}) VALUES(${keys.map((key) => `@${key}`)})`).run(record);
    };
    for (const q of questions) {
      const response =
        q.answer_type === 'skipped' && q.answer_value === null
          ? { responseType: 'skipped' }
          : { responseType: q.answer_type, value: q.answer_value };
      if (
        (q.status === 'answered' && (!isQuestionResponse(response) || !q.answered_at)) ||
        (q.status !== 'answered' && (q.answer_type !== null || q.answer_value !== null))
      )
        throw new Error(`Invalid question response: ${q.question_id}`);
      insert({
        id: q.question_id,
        kind: 'question',
        session_id: q.session_id,
        message_out_id: q.message_out_id,
        in_reply_to: q.in_reply_to,
        platform_id: q.platform_id,
        channel_type: q.channel_type,
        thread_id: q.thread_id,
        input_json: JSON.stringify(questionInput(db, options.sessions, q)),
        status: q.status,
        response_json: q.status === 'answered' ? JSON.stringify(response) : null,
        responded_by: q.answered_by,
        responded_at: q.answered_at,
        resolved_at: q.cancelled_at ?? q.answered_at,
        created_at: q.created_at,
        updated_at: q.cancelled_at ?? q.answered_at ?? q.created_at,
      });
    }
    for (const a of approvals) {
      const { approval_id, action, payload, title, options_json, decision, response_message, ...record } = a;
      const input = { action, payload: objectBody(JSON.parse(payload)), title, options: JSON.parse(options_json) };
      if (!isQuestionInput({ question: title, responseMode: 'choice', options: input.options }))
        throw new Error(`Invalid approval input: ${approval_id}`);
      if (a.kind !== 'confirmation') accessRequestInput(input.payload);
      insert({
        ...record,
        id: approval_id,
        input_json: JSON.stringify(input),
        response_json: JSON.stringify({ decision, message: response_message }),
      });
    }
    db.exec(`INSERT INTO interaction_progress(id,data_json,submission_ids_json,restart,notified)
      SELECT approval_id,data_json,submission_ids_json,restart,notified FROM approval_workflows;
      DROP TABLE approval_workflows; DROP TABLE approvals; DROP TABLE questions;`);
    db.prepare(
      `INSERT INTO schema_version(version,name,applied)
      SELECT COALESCE(MAX(version),0)+1,?,? FROM schema_version`,
    ).run(migration049.name, new Date().toISOString());
    check(db);
    db.exec('COMMIT');
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  if (
    !['--db', '--sessions', '--backup'].every(
      (flag) => args.includes(flag) && value(flag) && !value(flag).startsWith('--'),
    )
  )
    throw new Error(
      'Usage: cutover-interactions.ts --db <offline/v2.db> --sessions <offline/v2-sessions> --backup <private/new.db> --offline',
    );
  await cutoverInteractions({
    db: value('--db'),
    sessions: value('--sessions'),
    backup: value('--backup'),
    offline: args.includes('--offline'),
  });
}
