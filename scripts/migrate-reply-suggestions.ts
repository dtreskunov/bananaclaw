#!/usr/bin/env -S pnpm exec tsx
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalCopy,
  converge,
  fail,
  openSnapshot,
  put,
  rows,
  tables,
  type EventProof,
  type Row,
  type Store,
} from './migrate-reply-suggestions-db.js';

type Json = Record<string, unknown>;
interface Session extends Row {
  id: string;
  agent_group_id: string;
}
interface Question extends Row {
  id: string;
  session_id: string;
  message_out_id: string;
  input_json: string;
  response_json: string | null;
  status: string;
}
type QuestionContext = Pick<Question, 'id' | 'message_out_id' | 'input_json' | 'status'> & {
  responded_by?: Row['responded_by'];
};
interface Archive extends Json {
  version: number;
  agent_group: Row & { id: string };
  sessions: Session[];
  interactions: Row[];
}
interface PlannedStore {
  relative: string;
  store: Store;
  filename: string;
}
export interface MigrationOptions {
  sourceRoot: string;
  outputRoot: string;
  hostStopped: boolean;
  runnersStopped: boolean;
  canonicalHostProjection?: boolean;
}
export interface CandidateManifest {
  format: 'reply-suggestions-candidate';
  version: 1;
  storageVersion: 2;
  nativeStorageVersion: 1;
  archiveVersion: 4;
  candidateOnly: true;
  projectionAuthority: 'strict' | 'host';
  sourceRoot: string;
  confirmations: { hostStopped: true; runnersStopped: true };
  sourceFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  counts: Record<string, number>;
  stores: {
    path: string;
    store: Store | 'native';
    sourceVersion: number;
    targetVersion: number;
    rows: Record<string, number>;
  }[];
  events: (EventProof & { session: string })[];
  requires: string[];
}

const OLD_TYPES = new Set(['ask_question', 'question_response', 'interactive_response', 'ask_user_question']);
const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_ARCHIVE_ARRAYS = [
  'messaging_group_agents',
  'agent_group_members',
  'user_roles',
  'agent_destinations_owned',
  'agent_destinations_pointing',
  'pending_sender_approvals',
  'pending_channel_approvals',
  'interactions',
  'sessions',
];

function object(value: unknown, context: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${context}`);
  return value as Json;
}

function json(value: string, context: string): Json {
  try {
    return object(JSON.parse(value), context);
  } catch (error) {
    if (error instanceof SyntaxError) fail(`invalid JSON ${context}`);
    throw error;
  }
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`missing ${context}`);
  return value;
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function noSymlinkComponents(file: string): void {
  let current = path.parse(file).root;
  for (const component of file.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`symlink path component: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function validateRoots(options: MigrationOptions): { source: string; output: string } {
  if (options.hostStopped !== true || options.runnersStopped !== true)
    fail('both --host-stopped AND --runners-stopped are required');
  text(options.sourceRoot, 'explicit source root');
  text(options.outputRoot, 'explicit output root');
  const source = path.resolve(options.sourceRoot);
  const output = path.resolve(options.outputRoot);
  if ([source, output].some((root) => root === CHECKOUT_ROOT ||
    ['data', 'groups'].some((directory) => inside(path.join(CHECKOUT_ROOT, directory), root)))) {
    fail('the running checkout and its live data/groups are forbidden; use an isolated fixture/offline backup');
  }
  if (inside(source, output) || inside(output, source))
    fail('source/output roots must be separate, not equal or nested');
  noSymlinkComponents(source);
  noSymlinkComponents(output);
  if (!fs.statSync(source).isDirectory()) fail('source root must be a directory');
  try {
    fs.lstatSync(output);
    fail('output root must be NEW and nonexistent');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!fs.statSync(path.dirname(output)).isDirectory()) fail('output parent must already exist');
  return { source, output };
}

function inventory(source: string): string[] {
  const result: string[] = [];
  noSymlinkComponents(path.join(source, 'data'));
  for (const entry of fs.readdirSync(path.join(source, 'data'))) {
    if (/\.(?:db|sqlite|sqlite3)$/.test(entry) && entry !== 'v2.db') {
      fail(`unknown data database ${entry}; external search/provider state needs an explicit converter`);
    }
  }
  const visit = (relative: string): void => {
    const file = path.join(source, relative);
    noSymlinkComponents(file);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail(`source symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) visit(path.join(relative, entry));
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) fail(`hard-linked source file: ${relative}; use an independent offline copy`);
      if (/(?:-wal|-shm|-journal)$/.test(relative))
        fail(`SQLite sidecar present: ${relative}; obtain a clean stopped snapshot`);
      if (relative.endsWith('.db'))
        for (const suffix of ['-wal', '-shm', '-journal']) {
          try {
            fs.lstatSync(file + suffix);
            fail(`SQLite sidecar present: ${relative}${suffix}; obtain a clean stopped snapshot`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      result.push(relative);
    } else fail(`special source file: ${relative}`);
  };
  visit(path.join('data', 'v2.db'));
  for (const relative of [path.join('data', 'v2-sessions'), 'groups']) {
    if (fs.existsSync(path.join(source, relative))) visit(relative);
  }
  return result.sort();
}

function hashes(root: string, files: string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((relative) => {
      const file = path.join(root, relative);
      noSymlinkComponents(file);
      const hash = crypto.createHash('sha256');
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let length: number;
        while ((length = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0)
          hash.update(buffer.subarray(0, length));
      } finally {
        fs.closeSync(handle);
      }
      return [relative, hash.digest('hex')];
    }),
  );
}

function hasOldExecutable(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOldExecutable);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (['type', 'kind', 'name', 'tool', 'toolName', 'tool_name'].includes(key) &&
        typeof item === 'string' &&
        OLD_TYPES.has(item)) ||
      hasOldExecutable(item),
  );
}

function quote(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

function options(value: unknown): { label: string; selectedLabel: string; value: string }[] {
  if (!Array.isArray(value)) fail('question options are missing');
  return value.map((item) => {
    if (typeof item === 'string') return { label: item, selectedLabel: item, value: item };
    const entry = object(item, 'question option');
    const label = text(entry.label, 'option label');
    return {
      label,
      selectedLabel: entry.selectedLabel === undefined ? label : text(entry.selectedLabel, 'selected label'),
      value: entry.value === undefined ? label : text(entry.value, 'option value'),
    };
  });
}

function questionText(question: QuestionContext): string {
  const input = json(question.input_json, `question ${question.id}`);
  const labels = options(input.options).map((option) => `- ${option.label}`);
  const state =
    question.status === 'pending'
      ? '\n\nThis historical question was pending at cutover. Interactive answering is no longer available; reply in ordinary chat if needed.'
      : question.status === 'cancelled'
        ? '\n\nThis historical question was cancelled. No user response was recorded.'
        : '';
  return [text(input.question, 'question text'), ...labels].join('\n') + state;
}

function answerText(content: Json, question?: QuestionContext): string {
  const context =
    typeof content.question === 'string'
      ? content.question
      : question
        ? text(json(question.input_json, 'question input').question, 'question text')
        : '';
  if (!context) fail('question response lacks quote context');
  let answer: string;
  if (content.responseType === 'skipped') {
    if ('value' in content) fail('skipped response unexpectedly contains a value');
    answer = 'The user explicitly skipped this question.';
  } else {
    if (content.responseType !== 'text' && content.responseType !== 'choice') fail('unknown response semantics');
    if (typeof content.value !== 'string') fail('recorded answer must be a string');
    answer = content.value;
    if (content.responseType === 'choice' && question) {
      const matches = options(json(question.input_json, 'question input').options).filter(
        (option) => option.value === answer,
      );
      if (matches.length !== 1) fail(`ambiguous recorded option value for ${question.id}`);
      const option = matches[0];
      if (option.selectedLabel !== answer)
        answer = `${option.selectedLabel} (recorded value: ${JSON.stringify(answer)})`;
    }
  }
  return `${quote(context)}\n\n${answer}`;
}

function transformInput(row: Row, questions: Map<string, QuestionContext>, central: Database.Database): Row {
  let content: Json;
  try {
    content = json(String(row.content), `input ${row.id}`);
  } catch (error) {
    if (row.kind === 'interactive_response') throw error;
    return row;
  }
  if (row.kind === 'system' && content.type === 'question_response') {
    const { questionId, ...rest } = content;
    return {
      ...row,
      content: JSON.stringify({ ...rest, type: 'system_response', requestId: text(questionId, 'system request id') }),
    };
  }
  if (row.kind !== 'interactive_response') {
    if (hasOldExecutable(content)) fail(`unrecognized old executable input ${row.id}`);
    return row;
  }
  if (content.type !== 'question_response') fail(`interactive input ${row.id} has unknown content`);
  const question = questions.get(String(content.questionId));
  const next: Json = { text: answerText(content, question) };
  for (const key of ['sender', 'sender_id', 'sender_user_id', 'is_bot', 'is_from_me', 'timelinePosition']) {
    if (content[key] !== undefined) next[key] = content[key];
  }
  const userId = row.sender_user_id || content.userId || question?.responded_by;
  if (typeof userId === 'string' && userId) {
    const user = central.prepare('SELECT display_name FROM users WHERE id=?').get(userId) as Row | undefined;
    if (user?.display_name && next.sender === undefined) next.sender = user.display_name;
    if (next.sender_id === undefined) next.sender_id = row.sender_identity || userId;
  }
  return { ...row, kind: 'chat', content: JSON.stringify(next) };
}

function transformOutput(row: Row, questions: Map<string, QuestionContext>, approvals: Map<string, Row>): Row {
  let content: Json;
  try {
    content = json(String(row.content), `output ${row.id}`);
  } catch {
    return row;
  }
  if (content.type !== 'ask_question') {
    if (hasOldExecutable(content)) fail(`unrecognized old executable output ${row.id}`);
    return row;
  }
  const id = text(content.questionId, 'question/approval id');
  const question = questions.get(id);
  if (!question) {
    const approval = approvals.get(id);
    if (!approval) fail(`unmatched ask_question output ${row.id}`);
    const next: Json = {
      type: 'approval_request',
      approvalId: id,
      title: typeof content.title === 'string' ? content.title : '',
      body: typeof content.question === 'string' ? content.question : text(content.body, 'approval body'),
      options: content.options,
    };
    options(content.options);
    if (content.timelinePosition !== undefined) next.timelinePosition = content.timelinePosition;
    return { ...row, content: JSON.stringify(next) };
  }
  if (question.message_out_id !== row.id) fail(`question ${id} output anchor mismatch`);
  const next: Json = { text: questionText(question), delivery_origin: 'send_message' };
  if (content.timelinePosition !== undefined) next.timelinePosition = content.timelinePosition;
  for (const key of ['files', 'file_paths']) if (content[key] !== undefined) next[key] = content[key];
  return { ...row, kind: 'chat', content: JSON.stringify(next) };
}

function verifyQuestions(
  questions: Question[],
  inbound: Database.Database,
  outbound: Database.Database,
  runner: Database.Database,
): void {
  for (const question of questions) {
    if (!['pending', 'answered', 'cancelled'].includes(question.status))
      fail(`unsupported question state ${question.status}`);
    const output = outbound.prepare('SELECT * FROM messages_out WHERE id=?').get(question.message_out_id) as
      | Row
      | undefined;
    const runnerOutput = runner.prepare('SELECT * FROM messages_out WHERE id=?').get(question.message_out_id) as
      | Row
      | undefined;
    if (!output || !runnerOutput) fail(`question ${question.id} is missing output evidence`);
    const content = json(String(output.content), 'question output');
    if (content.type !== 'ask_question' || content.questionId !== question.id)
      fail(`question ${question.id} output differs from central evidence`);
    const questionInput = json(question.input_json, 'central question input');
    if (
      content.question !== questionInput.question ||
      JSON.stringify(options(content.options)) !== JSON.stringify(options(questionInput.options)) ||
      (content.responseMode !== undefined &&
        questionInput.responseMode !== undefined &&
        content.responseMode !== questionInput.responseMode)
    ) {
      fail(`question ${question.id} text/options differ from central evidence`);
    }
    const inputId = `question-response:${question.id}`;
    const input = inbound.prepare('SELECT * FROM messages_in WHERE id=?').get(inputId) as Row | undefined;
    const runnerInput = runner.prepare('SELECT * FROM messages_in WHERE id=?').get(inputId) as Row | undefined;
    for (const key of ['platform_id', 'channel_type', 'thread_id']) {
      if (question[key] !== null && question[key] !== undefined && question[key] !== output[key])
        fail(`question ${question.id} output route conflicts`);
    }
    if (question.status !== 'answered') {
      if (input || runnerInput) fail(`unanswered question ${question.id} unexpectedly has a user response`);
      continue;
    }
    // A missing deterministic row has no trustworthy sequence/state/author/turn.
    if (!input || !runnerInput)
      fail(
        `answered question ${question.id} lacks deterministic inbound evidence ${inputId}; no fabricated answer/turn/author`,
      );
    const response = json(String(input.content), 'recorded response');
    const centralResponse = json(text(question.response_json, 'central response'), 'central response');
    if (
      input.kind !== 'interactive_response' ||
      response.type !== 'question_response' ||
      response.questionId !== question.id ||
      response.question !== questionInput.question ||
      response.responseType !== centralResponse.responseType ||
      response.value !== centralResponse.value ||
      input.timestamp !== question.responded_at
    ) {
      fail(`answered question ${question.id} response evidence conflicts`);
    }
    if (question.responded_by && response.userId && question.responded_by !== response.userId)
      fail('answer author evidence conflicts');
    if (question.responded_by && input.sender_user_id && question.responded_by !== input.sender_user_id)
      fail('canonical answer author evidence conflicts');
    if (response.responseType === 'choice') answerText(response, question);
  }
}

function verifyNoOld(db: Database.Database, context: string): void {
  for (const table of tables(db)) {
    for (const row of rows(db, table)) {
      if (row.kind === 'question' || row.kind === 'interactive_response') fail(`${context}:${table} retains old kind`);
      if (table === 'session_state' && String(row.key).startsWith('runner:suggested-responses:')) {
        fail(`${context}: unfinalized suggestion state requires online settle barrier`);
      }
      for (const [key, value] of Object.entries(row)) {
        if (typeof value !== 'string' || !/^(?:content|value|.*_json|payload|continuation|digest)$/.test(key)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          continue;
        }
        if (hasOldExecutable(parsed)) fail(`${context}:${table}.${key} needs explicit structural/provider conversion`);
      }
    }
  }
}

function markSummaryRebuild(db: Database.Database): void {
  if (tables(db).includes('thread_summary_meta')) {
    db.prepare('UPDATE thread_summary_meta SET ready=0').run();
    db.exec('DELETE FROM thread_summaries');
  }
}

function verifyNativeStore(file: string): Record<string, number> {
  const db = openSnapshot(file);
  try {
    if (db.pragma('user_version', { simple: true }) !== 1) fail('native provider stores must remain at version 1');
    const columns: Record<string, string[]> = {
      conversations: ['id', 'created_at', 'updated_at'],
      messages: ['id', 'conversation_id', 'content_json', 'created_at'],
      applied_steering: ['conversation_id', 'steering_id', 'message_id'],
      context_compactions: ['conversation_id', 'through_id', 'summary', 'retained_ids'],
      finished_turns: ['conversation_id', 'first_id', 'last_id'],
      media_quarantines: ['conversation_id', 'provider_scope', 'media_key', 'confirmed_ref', 'reason'],
      tool_results: ['id', 'content_json'],
    };
    if (tables(db).some((name) => !columns[name])) fail(`unknown native provider table in ${file}`);
    for (const required of ['conversations', 'messages'])
      if (!tables(db).includes(required)) fail(`native provider required table missing: ${file}`);
    for (const [table, expected] of Object.entries(columns)) {
      if (!tables(db).includes(table)) continue;
      const actual = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
      if (JSON.stringify(actual.map((column) => column.name).sort()) !== JSON.stringify(expected.slice().sort())) {
        fail(`native provider ${table} requires structural conversion: ${file}`);
      }
    }
    const calls = new Map<string, string>();
    const results = new Map<string, string>();
    for (const table of tables(db))
      for (const row of rows(db, table))
        for (const [key, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            if (key.endsWith('_json') || key === 'retained_ids') fail(`malformed native history in ${file}`);
            continue;
          }
          if (table === 'messages' && key === 'content_json') {
            const message = object(parsed, 'native model message');
            if (
              !['system', 'user', 'assistant', 'tool'].includes(String(message.role)) ||
              !(typeof message.content === 'string' || Array.isArray(message.content))
            )
              fail(`native history requires structural conversion: ${file}`);
            if (Array.isArray(message.content))
              for (const item of message.content) {
                const part = object(item, 'native message part');
                if (part.type !== 'tool-call' && part.type !== 'tool-result') continue;
                if (typeof part.toolName !== 'string' || typeof part.toolCallId !== 'string' || !part.toolCallId)
                  fail(`native history requires structural conversion: ${file}`);
                const identity = `${row.conversation_id}:${part.toolCallId}`;
                if (part.type === 'tool-call' && part.toolName.endsWith('ask_user_question')) {
                  if (message.role !== 'assistant' || !('input' in part))
                    fail(`native history requires structural conversion: ${file}`);
                  calls.set(identity, part.toolName);
                } else if (part.type === 'tool-result') {
                  if (message.role !== 'tool' || !('output' in part))
                    fail(`native history requires structural conversion: ${file}`);
                  results.set(identity, part.toolName);
                }
              }
          }
        }
    for (const [identity, name] of calls)
      if (results.get(identity) !== name) fail(`native history has an unresolved retired tool call: ${file}`);
    return Object.fromEntries(tables(db).map((table) => [table, rows(db, table).length]));
  } finally {
    db.close();
  }
}

export function migrateReplySuggestions(options_: MigrationOptions): CandidateManifest {
  const { source, output } = validateRoots(options_);
  const files = inventory(source);
  const sourceFiles = hashes(source, files);
  const scratch = fs.mkdtempSync(path.join(path.dirname(output), '.reply-suggestions-preflight-'));
  const central = openSnapshot(path.join(source, 'data', 'v2.db'), scratch);
  const snapshots = new Set<Database.Database>([central]);
  const targets = new Set<Database.Database>();
  const planned: PlannedStore[] = [];
  const archives = new Map<string, Archive>();
  const coveredSessions = new Set<string>();
  const manifest: CandidateManifest = {
    format: 'reply-suggestions-candidate',
    version: 1,
    storageVersion: 2,
    nativeStorageVersion: 1,
    archiveVersion: 4,
    candidateOnly: true,
    projectionAuthority: options_.canonicalHostProjection ? 'host' : 'strict',
    sourceRoot: source,
    confirmations: { hostStopped: true, runnersStopped: true },
    sourceFiles,
    candidateFiles: {},
    counts: { sessions: 0, archives: 0, questions: 0, inputs: 0, outputs: 0 },
    stores: [],
    events: [],
    requires: [
      'Rebuild maintained thread summaries/search before exposing candidate history; retain publication/read positions and unread baselines.',
      'Externally delivered approval buttons require explicit offline-planned reissue with canonical nca:<approvalId>:<index>; this tool never sends network requests.',
      'No install operation exists. Review the manifest and independently test with host/runners still stopped.',
    ],
  };
  try {
    const contexts: { sessions: Session[]; interactions: Row[]; tree: string; archive?: Archive }[] = [
      {
        sessions: rows(central, 'sessions') as Session[],
        interactions: rows(central, 'interactions'),
        tree: path.join('data', 'v2-sessions'),
      },
    ];
    for (const relative of files.filter(
      (file) => path.basename(file) === 'archive.json' && file.startsWith(`groups${path.sep}`),
    )) {
      const archive = json(fs.readFileSync(path.join(source, relative), 'utf8'), 'archive') as Archive;
      if (archive.version !== 3 && archive.version !== 4)
        fail(`archive ${relative}: only complete v3/v4 exports are supported`);
      for (const key of REQUIRED_ARCHIVE_ARRAYS)
        if (!Array.isArray(archive[key]))
          fail(`archive ${relative} omitted ${key}; old partial exports cannot be restored`);
      const archiveKeys = new Set([
        'version',
        'archived_at',
        'archived_by',
        'agent_group',
        'container_config',
        ...REQUIRED_ARCHIVE_ARRAYS,
      ]);
      if (Object.keys(archive).some((key) => !archiveKeys.has(key))) fail(`archive ${relative} has unsupported fields`);
      if (
        archive.version === 4 &&
        archive.interactions.some((row) => row.kind === 'question' || 'message_out_id' in row || 'in_reply_to' in row)
      )
        fail(`archive ${relative} violates v4 approval-only shape`);
      text(archive.agent_group?.id, 'archived group id');
      const groupId = archive.agent_group.id;
      if (groupId === '.' || groupId === '..' || /[/\\]/.test(groupId)) fail('unsafe archived group id');
      const roots = new Set(
        files.filter((file) => file.startsWith(`data/v2-sessions/${groupId}~`)).map((file) => file.split(path.sep)[2]),
      );
      if (archive.sessions.length && roots.size !== 1)
        fail(`archive ${relative}: archived session tree ambiguous/missing`);
      const archivedTree = [...roots][0];
      if (
        archivedTree &&
        !new RegExp(`^${groupId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}~(?:[2-9]|[1-9][0-9]+)?$`).test(archivedTree)
      ) {
        fail('unsafe archived group tree');
      }
      contexts.push({
        sessions: archive.sessions,
        interactions: archive.interactions,
        tree: path.join('data', 'v2-sessions', archivedTree ?? `${groupId}~`),
        archive,
      });
      archives.set(relative, archive);
      manifest.counts.archives++;
    }
    for (const context of contexts) {
      const questions = context.interactions.filter((row) => row.kind === 'question') as Question[];
      const approvals = new Map(
        context.interactions.filter((row) => row.kind !== 'question').map((row) => [String(row.id), row]),
      );
      for (const approval of approvals.values())
        if (!['confirmation', 'account_setup', 'access_grant'].includes(String(approval.kind)))
          fail('unknown interaction kind');
      const questionMap = new Map(questions.map((question) => [question.id, question]));
      for (const session of context.sessions) {
        text(session.id, 'session id');
        text(session.agent_group_id, 'session group id');
        if ([session.id, session.agent_group_id].some((id) => id === '.' || id === '..' || /[/\\]/.test(id)))
          fail('unsafe session path');
        const directory = context.archive
          ? path.join(context.tree, session.id)
          : path.join(context.tree, session.agent_group_id, session.id);
        if (coveredSessions.has(directory)) fail(`duplicate session inventory ${directory}`);
        coveredSessions.add(directory);
        const specs: [Store, string][] = [
          ['inbound', 'inbound.db'],
          ['outbound', 'outbound.db'],
          ['runner', path.join('runner-state', 'runner-state.db')],
        ];
        const dbs = specs.map(([store, name]) => {
          const relative = path.join(directory, name);
          if (!files.includes(relative)) fail(`required ${store} copy missing: ${relative}`);
          const db = openSnapshot(path.join(source, relative), scratch);
          snapshots.add(db);
          planned.push({ relative, store, filename: db.name });
          return db;
        });
        const [inbound, outbound, runner] = dbs;
        try {
          manifest.events.push(
            ...converge(inbound, outbound, runner, options_.canonicalHostProjection).map((proof) => ({
              ...proof,
              session: directory,
            })),
          );
        } catch (error) {
          throw new Error(`Session ${directory}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
        const sessionQuestions = questions.filter((question) => question.session_id === session.id);
        verifyQuestions(sessionQuestions, inbound, outbound, runner);
        const scopedQuestions = new Map<string, QuestionContext>(questionMap);
        for (const row of rows(outbound, 'messages_out')) {
          const payload = json(String(row.content), `historical output ${row.id}`);
          if (payload.type !== 'ask_question') continue;
          const id = text(payload.questionId, 'historical question id');
          if (scopedQuestions.has(id) || approvals.has(id)) continue;
          const recordedOptions = options(payload.options);
          scopedQuestions.set(id, {
            id,
            message_out_id: String(row.id),
            input_json: JSON.stringify({
              question: text(payload.question, 'historical question text'),
              options: recordedOptions,
            }),
            status: 'historical',
          });
          manifest.counts.historicalQuestionContexts = (manifest.counts.historicalQuestionContexts ?? 0) + 1;
        }
        for (const db of [inbound, runner]) {
          for (const row of rows(db, 'messages_in')) {
            const next = transformInput(row, scopedQuestions, central);
            if (next !== row) {
              put(db, 'messages_in', next);
              if (db === inbound) manifest.counts.inputs++;
            }
          }
        }
        for (const db of [outbound, runner]) {
          for (const row of rows(db, 'messages_out')) {
            const next = transformOutput(row, scopedQuestions, approvals);
            if (next !== row) {
              put(db, 'messages_out', next);
              if (db === outbound) manifest.counts.outputs++;
            }
          }
        }
        for (const question of sessionQuestions) {
          if (context.archive) continue;
          for (const publication of rows(central, 'conversation_publications').filter(
            (row) => row.kind === 'question' && row.item_id === question.id && row.session_id === session.id,
          )) {
            for (const key of ['channel_type', 'platform_id', 'thread_id']) {
              if (question[key] !== null && question[key] !== undefined && question[key] !== publication[key]) {
                fail(`question ${question.id} publication route conflicts; unread history cannot be reassigned`);
              }
            }
            const collision = central
              .prepare(
                `SELECT position FROM conversation_publications
              WHERE session_id=? AND kind='message' AND item_id=? AND channel_type=? AND platform_id=? AND thread_id=?`,
              )
              .get(
                publication.session_id,
                question.message_out_id,
                publication.channel_type,
                publication.platform_id,
                publication.thread_id,
              );
            if (collision)
              fail(`publication position collision for question ${question.id}; cannot merge unread history`);
            // Source's legacy schema permits both kinds. The fresh schema is copied later.
            central
              .prepare("UPDATE conversation_publications SET kind='message',item_id=? WHERE position=?")
              .run(question.message_out_id, publication.position);
          }
        }
        manifest.counts.questions += sessionQuestions.length;
        manifest.counts.sessions++;
        for (const db of dbs) {
          db.close();
          snapshots.delete(db);
        }
        if (manifest.counts.sessions % 25 === 0)
          console.error(`Migration progress: reconciled ${manifest.counts.sessions} sessions`);
      }
      if (questions.some((question) => !context.sessions.some((session) => session.id === question.session_id)))
        fail('question references uninventoried session');
      if (context.archive) {
        context.archive.version = 4;
        context.archive.interactions = [...approvals.values()].map(
          ({ message_out_id: _out, in_reply_to: _reply, ...row }) => row,
        );
      }
    }
    for (const relative of files.filter((file) => /\.db$/.test(file) && file !== 'data/v2.db')) {
      if (planned.some((store) => store.relative === relative)) continue;
      const nativeSuffix = path.join('native-state', 'native-state.db');
      if (![...coveredSessions].some((directory) => relative === path.join(directory, nativeSuffix))) {
        fail(`uninventoried/provider-native database ${relative}; explicit review required`);
      }
      const nativeRows = verifyNativeStore(path.join(source, relative));
      manifest.stores.push({ path: relative, store: 'native', sourceVersion: 1, targetVersion: 1, rows: nativeRows });
      manifest.counts.nativeStores = (manifest.counts.nativeStores ?? 0) + 1;
    }
    if (rows(central, 'conversation_publications').some((row) => row.kind === 'question'))
      fail('unresolved question publication');
    // Only after output, response, route, publication and queue proofs succeeded.
    central.exec("DELETE FROM interaction_progress WHERE id IN (SELECT id FROM interactions WHERE kind='question')");
    central.exec("DELETE FROM interactions WHERE kind='question'");
    markSummaryRebuild(central);
    planned.push({ relative: path.join('data', 'v2.db'), store: 'central', filename: central.name });
    central.close();
    snapshots.delete(central);
    const generated = new Map<string, string>();
    for (const plan of planned) {
      const sourceDb = new Database(plan.filename);
      sourceDb.pragma('cache_size=-128');
      snapshots.add(sourceDb);
      verifyNoOld(sourceDb, plan.relative);
      const filename = path.join(scratch, `${crypto.randomUUID()}.db`);
      const target = canonicalCopy(sourceDb, plan.store, filename);
      targets.add(target);
      verifyNoOld(target, plan.relative);
      generated.set(plan.relative, filename);
      manifest.stores.push({
        path: plan.relative,
        store: plan.store,
        sourceVersion: Number(sourceDb.pragma('user_version', { simple: true })),
        targetVersion: 2,
        rows: Object.fromEntries(tables(target).map((table) => [table, rows(target, table).length])),
      });
      manifest.counts[`${plan.store}Rows`] =
        (manifest.counts[`${plan.store}Rows`] ?? 0) +
        tables(target).reduce((sum, table) => sum + rows(target, table).length, 0);
      target.close();
      targets.delete(target);
      sourceDb.close();
      snapshots.delete(sourceDb);
      if (manifest.stores.length % 50 === 0)
        console.error(`Migration progress: rebuilt ${manifest.stores.length} stores`);
    }
    for (const [relative, archive] of archives) {
      if (hasOldExecutable(archive)) fail('archive retains old executable interactions');
      const filename = path.join(scratch, `${crypto.randomUUID()}.json`);
      fs.writeFileSync(filename, JSON.stringify(archive, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      generated.set(relative, filename);
    }
    for (const relative of files) {
      if (generated.has(relative)) continue;
      const data = /\.(?:json|jsonl|ts|js|md)$/.test(relative) ? fs.readFileSync(path.join(source, relative)) : null;
      if (/\.(?:json|jsonl)$/.test(relative)) {
        const fragments = relative.endsWith('.jsonl')
          ? data!.toString('utf8').split(/\r?\n/).filter(Boolean)
          : [data!.toString('utf8')];
        for (const fragment of fragments) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(fragment);
          } catch {
            fail(`opaque JSON artifact ${relative} is malformed; explicit converter required`);
          }
          if (hasOldExecutable(parsed)) fail(`opaque artifact ${relative} needs structural conversion`);
        }
      }
      if (
        /\.(?:json|jsonl|ts|js|md)$/.test(relative) &&
        /(?:ask_user_question|"(?:type|kind|name|tool)"\s*:\s*"(?:ask_question|question_response|interactive_response)")/.test(
          data!.toString('utf8'),
        )
      ) {
        fail(
          `opaque provider/group artifact ${relative} needs structural conversion; it will not be rewritten or resumed`,
        );
      }
      generated.set(relative, path.join(source, relative));
    }
    const unchanged = hashes(source, inventory(source));
    if (JSON.stringify(unchanged) !== JSON.stringify(sourceFiles)) fail('source changed during preflight');
    fs.mkdirSync(output, { mode: 0o700 });
    for (const [relative, filename] of generated) {
      const destination = path.join(output, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(filename, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
      const handle = fs.openSync(destination, 'r');
      try { fs.fsyncSync(handle); }
      finally { fs.closeSync(handle); }
    }
    for (const plan of planned) {
      const persisted = new Database(path.join(output, plan.relative), { readonly: true, fileMustExist: true });
      try {
        if (
          persisted.pragma('user_version', { simple: true }) !== 2 ||
          persisted.pragma('integrity_check', { simple: true }) !== 'ok' ||
          (persisted.pragma('foreign_key_check') as unknown[]).length
        )
          fail(`persisted candidate failed verification: ${plan.relative}`);
        verifyNoOld(persisted, plan.relative);
        const expected = manifest.stores.find((store) => store.path === plan.relative)?.rows;
        const actual = Object.fromEntries(tables(persisted).map((table) => [table, rows(persisted, table).length]));
        if (!expected || JSON.stringify(actual) !== JSON.stringify(expected))
          fail(`persisted candidate row counts changed: ${plan.relative}`);
      } finally {
        persisted.close();
      }
    }
    manifest.candidateFiles = hashes(output, [...generated.keys()].sort());
    fs.writeFileSync(path.join(output, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    if (JSON.stringify(hashes(source, inventory(source))) !== JSON.stringify(sourceFiles))
      fail('source changed while writing candidate; discard candidate');
    return manifest;
  } finally {
    for (const db of [...targets, ...snapshots]) if (db.open) db.close();
    fs.rmSync(scratch, { recursive: true });
  }
}

export function parseArgs(args: string[]): MigrationOptions {
  const result: MigrationOptions = { sourceRoot: '', outputRoot: '', hostStopped: false, runnersStopped: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) fail(`duplicate argument ${arg}`);
    seen.add(arg);
    if (arg === '--host-stopped') result.hostStopped = true;
    else if (arg === '--runners-stopped') result.runnersStopped = true;
    else if (arg === '--canonical-host-projection') result.canonicalHostProjection = true;
    else if (arg === '--source-root' || arg === '--output-root') {
      const value = args[++index];
      if (!value || value.startsWith('--')) fail(`missing value for ${arg}`);
      result[arg === '--source-root' ? 'sourceRoot' : 'outputRoot'] = value;
    } else fail(`unknown argument ${arg}; there is no install/force operation`);
  }
  if (!result.sourceRoot || !result.outputRoot) fail('--source-root and --output-root are required');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = migrateReplySuggestions(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Verified private candidate only: ${JSON.stringify(manifest.counts)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
