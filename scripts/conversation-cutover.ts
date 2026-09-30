/**
 * Offline staging copies ONLY. See docs/conversation-cutover.md.
 * bun scripts/conversation-cutover.ts --staging-data-dir ./cutover/data --attest-offline-copy [--apply|--verify|--retry|--rollback]
 *
 * Bun's SQLite implementation runs the mirrored migration on both private stores;
 * only the runner gets its journal upgraded. No runtime opens the other peer's DB.
 *
 * Memory is bounded by the largest single session: sessions are opened, checked,
 * migrated and verified one at a time, and files/tables are hashed as streams.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DATA_DIR } from '../src/config.js';
import {
  CONVERSATION_CUTOVER_MANIFEST,
  CONVERSATION_CUTOVER_MANIFEST_VERSION as MANIFEST_VERSION,
} from '../src/conversation-cutover.js';
import {
  backfillTurns,
  type TurnBackfillEvidence,
  type TurnInputEvidence,
} from '../container/agent-runner/src/db/turns.js';
import { migrateRunnerTurnJournal } from '../container/agent-runner/src/db/runner-state.js';

type Row = Record<string, unknown>;
type Phase = 'backing-up' | 'applying' | 'verifying' | 'verified' | 'failed' | 'restoring' | 'rolled-back';
interface TableSnapshot {
  name: string;
  columns: string[];
  count: number;
  digest: string;
}
interface FileSnapshot {
  name: string;
  before: string;
  after?: string;
  tables: TableSnapshot[];
}
interface Manifest {
  version: typeof MANIFEST_VERSION;
  phase: Phase;
  files: FileSnapshot[];
}
interface Store {
  name: string;
  file: string;
  db: Database;
}
type Mode = 'dry-run' | 'apply' | 'verify' | 'retry' | 'rollback';
type Progress = (message: string) => void;
const PROGRESS_LOG = path.join(path.dirname(CONVERSATION_CUTOVER_MANIFEST), 'progress.log');
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const has = (db: Database, table: string) =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const rows = (db: Database, table: string): Row[] => db.query(`SELECT * FROM ${quote(table)}`).all() as Row[];
const canonical = (row: Row) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

function fileHash(file: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1 << 20);
  const fd = fs.openSync(file, 'r');
  try {
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0; ) hash.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function saveManifest(root: string, manifest: Manifest): void {
  const file = path.join(root, CONVERSATION_CUTOVER_MANIFEST);
  if (fs.existsSync(`${file}.next`)) checkPath(`${file}.next`);
  fs.writeFileSync(`${file}.next`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  syncFile(`${file}.next`);
  fs.renameSync(`${file}.next`, file);
  syncFile(path.dirname(file));
}

/** Refuse aliases into live data, including hard links to another copy. */
function checkPath(file: string, directory = false): void {
  const stat = fs.lstatSync(file);
  if (
    fs.realpathSync(file) !== path.resolve(file) ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error('Expected private regular staging files/directories, not links');
}

function noSidecars(file: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) throw new Error(`SQLite sidecar present: ${path.basename(file)}${suffix}`);
  }
}

/** Find flat and agent/session layouts, never silently skip orphaned stores. */
export function discoverSessionFiles(root: string): string[] {
  const base = path.join(root, 'v2-sessions');
  const files: string[] = [];
  const visit = (dir: string) => {
    checkPath(dir, true);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const session = entries.some((entry) => ['inbound.db', 'outbound.db', 'runner-state'].includes(entry.name));
    for (const entry of entries) {
      // A session also contains provider stores, workspaces and package trees.
      // Only its explicitly named host/runner stores are migration inputs.
      if (session && !['inbound.db', 'outbound.db', 'runner-state'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlink in session tree; use a private dereferenced staging copy');
      if (entry.isDirectory()) {
        // Not session stores. In particular, never walk user attachment trees.
        if (!['inbox', 'outbox', '.claude-shared', 'agent-runner-src'].includes(entry.name)) visit(file);
      } else if (['inbound.db', 'outbound.db', 'runner-state.db'].includes(entry.name)) {
        checkPath(file);
        noSidecars(file);
        files.push(path.relative(root, file));
      }
    }
  };
  visit(base);
  const sessions = new Set<string>();
  for (const file of files) {
    const parts = file.split(path.sep).slice(1);
    const runner = parts.at(-1) === 'runner-state.db';
    if (runner && parts.at(-2) !== 'runner-state') throw new Error('Unexpected runner DB layout');
    const session = parts.slice(0, runner ? -2 : -1);
    if (![1, 2].includes(session.length)) throw new Error('Unexpected session DB depth');
    sessions.add(path.join('v2-sessions', ...session));
  }
  for (const session of sessions) {
    for (const name of ['inbound.db', 'outbound.db'])
      if (!files.includes(path.join(session, name))) throw new Error(`Incomplete session: missing ${name}`);
  }
  if (!files.length) throw new Error('No session databases found in staging data root');
  return files.sort();
}

function openStores(root: string, names: string[]): Store[] {
  const stores: Store[] = [];
  try {
    for (const name of names) {
      const file = path.join(root, name);
      noSidecars(file);
      const db = new Database(file, { readwrite: true, create: false, strict: true });
      stores.push({ name, file, db });
      db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON');
      if ((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode !== 'delete')
        throw new Error('Only drained DELETE-journal databases are supported; do not checkpoint a live store');
      // Even dry-run checks for other SQLite readers/writers, without writing.
      db.exec('BEGIN EXCLUSIVE');
      if ((db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok')
        throw new Error('SQLite integrity check failed');
      if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign key check failed');
      for (const table of ['pending_host_events', 'pending_runner_events']) {
        if (has(db, table) && db.query(`SELECT 1 FROM ${table} LIMIT 1`).get())
          throw new Error(`Undrained ${table}; drain with the old peers, never discard events`);
      }
    }
    return stores;
  } catch (error) {
    closeStores(stores);
    throw error;
  }
}

function closeStores(stores: Store[]): void {
  for (const { db } of stores.splice(0)) {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

/** Order-independent table digest; rows are streamed and only their hashes are retained. */
function tableDigest(db: Database, name: string, columns?: string[]): { count: number; digest: string } {
  const select = columns ? columns.map(quote).join(',') : '*';
  const hashes: string[] = [];
  for (const row of db.query(`SELECT ${select} FROM ${quote(name)}`).iterate() as IterableIterator<Row>)
    hashes.push(digest(canonical(row)));
  return { count: hashes.length, digest: digest(hashes.sort().join('\n')) };
}

function tableSnapshot(db: Database, name: string, columns: string[]): TableSnapshot {
  return { name, columns, ...tableDigest(db, name, columns) };
}

function preserve(db: Database): TableSnapshot[] {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
    name: string;
  }[];
  return tables
    .filter(({ name }) => !['turns', 'turn_inputs', 'conversation_sync_migrations'].includes(name))
    .map(({ name }) => {
      const columns = (db.query(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[])
        .map((c) => c.name)
        .filter((c) => c !== 'turn_id' || !['messages_out', 'turn_usage', 'turn_activity'].includes(name));
      return tableSnapshot(db, name, columns);
    });
}

function sameUsageEvidence(a: Row, b: Row): boolean {
  const { cost_usd: first, ...restA } = a;
  const { cost_usd: second, ...restB } = b;
  if (canonical(restA) !== canonical(restB)) return false;
  if (first === second) return true;
  // SQLite's JSON journal can round a double to its adjacent representable value.
  // This is comparison-only: preservation checks still hash each store exactly.
  return (
    typeof first === 'number' &&
    typeof second === 'number' &&
    Number.isFinite(first) &&
    Number.isFinite(second) &&
    first >= 0 &&
    second >= 0 &&
    Math.abs(first - second) <= Number.EPSILON * Math.max(first, second)
  );
}

function union<T extends object>(
  sets: T[][],
  key: (row: T) => string,
  equal: (a: T, b: T) => boolean = (a, b) => canonical(a as Row) === canonical(b as Row),
): T[] {
  const all = new Map<string, T>();
  for (const set of sets) {
    for (const row of set) {
      const id = key(row);
      const prior = all.get(id);
      if (prior && !equal(prior, row))
        throw new Error('Conflicting peer evidence; reconcile with the old peers before cutover');
      all.set(id, row);
    }
  }
  return [...all].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

/** Evidence for one session; `local` must be exactly that session's stores. */
function sessionEvidence(local: Store[]) {
  const outputs = local.filter((s) => path.basename(s.name) !== 'inbound.db');
  const inputSets = local
    .filter((s) => has(s.db, 'messages_in'))
    .map(
      ({ db }) =>
        db
          .query('SELECT id, channel_type, platform_id, thread_id, source_session_id FROM messages_in')
          .all() as TurnInputEvidence[],
    );
  // Full common rows must agree, but either peer may legitimately have a subset.
  for (const table of ['messages_out', 'turn_usage', 'turn_activity'])
    union<Row>(
      outputs.map(({ db }) => rows(db, table).map((r) => ({ ...r, turn_id: r.turn_id ?? null }))),
      (r) => (table === 'turn_activity' ? JSON.stringify([r.message_out_id, r.ordinal]) : String(r.id)),
      table === 'turn_usage' ? sameUsageEvidence : undefined,
    );
  const shared: TurnBackfillEvidence = {
    outputs: union(
      outputs.map(({ db }) =>
        rows(db, 'messages_out').map((r) => ({
          id: String(r.id),
          in_reply_to: r.in_reply_to as string | null,
          content: String(r.content),
          turn_id: (r.turn_id ?? null) as string | null,
        })),
      ),
      (r) => r.id,
    ),
    states: union(
      outputs.map(
        ({ db }) =>
          db
            .query("SELECT key, value FROM session_state WHERE key LIKE 'input:%'")
            .all() as TurnBackfillEvidence['states'],
      ),
      (r) => r.key,
    ),
    turns: union(
      outputs.map(({ db }) =>
        has(db, 'turns') ? (rows(db, 'turns') as unknown as TurnBackfillEvidence['turns']) : [],
      ),
      (r) => r.id,
    ),
    links: union(
      outputs.map(({ db }) =>
        has(db, 'turn_inputs') ? (rows(db, 'turn_inputs') as unknown as TurnBackfillEvidence['links']) : [],
      ),
      (r) => JSON.stringify([r.turn_id, r.message_in_id]),
    ),
  };
  return { outputs, inputs: union(inputSets, (r) => r.id), shared };
}

/** Group discovered files by session, preserving discovery order. */
function sessionGroups(names: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const dir = path.dirname(name);
    const session = path.basename(name) === 'runner-state.db' ? path.dirname(dir) : dir;
    groups.set(session, [...(groups.get(session) ?? []), name]);
  }
  return [...groups.values()];
}

/** Open, lock and preflight one session's stores, always releasing them afterwards. */
function withSession<T>(root: string, names: string[], run: (stores: Store[]) => T): T {
  const stores = openStores(root, names);
  try {
    return run(stores);
  } finally {
    closeStores(stores);
  }
}

function assertFileHashes(root: string, manifest: Manifest, names: string[], key: 'before' | 'after', error: string) {
  for (const name of names) {
    const file = manifest.files.find((f) => f.name === name);
    if (!file?.[key] || fileHash(path.join(root, name)) !== file[key]) throw new Error(error);
  }
}

function verify(root: string, stores: Store[], manifest: Manifest): void {
  for (const store of stores) {
    const saved = manifest.files.find((f) => f.name === store.name)!;
    for (const original of saved.tables) {
      if (JSON.stringify(tableSnapshot(store.db, original.name, original.columns)) !== JSON.stringify(original))
        throw new Error(`Original records changed in ${original.name}`);
    }
    if (store.db.query('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key verification failed');
    if (path.basename(store.name) === 'inbound.db') continue;
    const original = new Database(path.join(root, '.conversation-cutover', 'snapshot', store.name), { readonly: true });
    try {
      for (const table of ['turns', 'turn_inputs', 'messages_out', 'turn_usage', 'turn_activity']) {
        if (!has(original, table)) continue;
        for (const row of original.query(`SELECT * FROM ${quote(table)}`).iterate() as IterableIterator<Row>) {
          const identity =
            table === 'turn_inputs'
              ? ['turn_id', 'message_in_id']
              : table === 'turn_activity'
                ? ['message_out_id', 'ordinal']
                : ['id'];
          const priorTurn = table === 'turns' || table === 'turn_inputs';
          if (!priorTurn && row.turn_id == null) continue;
          const current = store.db
            .query(`SELECT * FROM ${table} WHERE ${identity.map((key) => `${key} IS ?`).join(' AND ')}`)
            .get(...identity.map((key) => row[key] as string | number | null)) as Row | null;
          if (!current || (priorTurn ? canonical(current) !== canonical(row) : current.turn_id !== row.turn_id))
            throw new Error('Existing turn identity or association changed');
        }
      }
    } finally {
      original.close();
    }
    for (const step of ['schema:1', 'backfill:1', ...(store.name.endsWith('runner-state.db') ? ['journal:2'] : [])]) {
      if (!store.db.query('SELECT 1 FROM conversation_sync_migrations WHERE step=?').get(step))
        throw new Error(`Missing migration marker: ${step}`);
    }
    if (store.db.query('SELECT 1 FROM messages_out WHERE turn_id IS NULL LIMIT 1').get())
      throw new Error('Missing output turn association');
    if (has(store.db, 'pending_runner_events') && store.db.query('SELECT 1 FROM pending_runner_events LIMIT 1').get())
      throw new Error('Migration unexpectedly enqueued runner events');
  }
  const { outputs } = sessionEvidence(stores);
  for (const table of ['turns', 'turn_inputs']) {
    const expected = tableDigest(outputs[0].db, table).digest;
    if (outputs.some(({ db }) => tableDigest(db, table).digest !== expected))
      throw new Error('Peer turn projection mismatch');
  }
}

function snapshots(root: string, manifest: Manifest, restore: boolean): void {
  // Validate the ENTIRE snapshot before touching any original.
  for (const file of manifest.files) {
    const backup = path.join(root, '.conversation-cutover', 'snapshot', file.name);
    checkPath(backup);
    noSidecars(backup);
    if (fileHash(backup) !== file.before) throw new Error('Snapshot missing or damaged; refusing partial restore');
  }
  if (!restore) return;
  manifest.phase = 'restoring';
  saveManifest(root, manifest);
  for (const file of manifest.files) {
    const target = path.join(root, file.name);
    fs.copyFileSync(path.join(root, '.conversation-cutover', 'snapshot', file.name), target);
    syncFile(target);
    if (fileHash(target) !== file.before) throw new Error('Snapshot restore verification failed');
    delete file.after;
  }
  manifest.phase = 'rolled-back';
  saveManifest(root, manifest);
}

function completeBackup(root: string, manifest: Manifest): void {
  // A killed backup can resume only while EVERY source still matches its baseline.
  for (const file of manifest.files)
    if (fileHash(path.join(root, file.name)) !== file.before)
      throw new Error('Source changed during backup; refusing to manufacture a mixed snapshot');
  for (const file of manifest.files) {
    const target = path.join(root, '.conversation-cutover', 'snapshot', file.name);
    if (fs.existsSync(target)) {
      checkPath(target);
      if (fileHash(target) !== file.before) throw new Error('Incomplete snapshot file is damaged');
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    checkPath(path.dirname(target), true);
    fs.copyFileSync(path.join(root, file.name), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    syncFile(target);
    syncFile(path.dirname(target));
  }
  snapshots(root, manifest, false);
  syncFile(path.join(root, '.conversation-cutover', 'snapshot'));
  syncFile(path.join(root, '.conversation-cutover'));
}

function recordProgress(root: string, session?: string): void {
  const file = path.join(root, PROGRESS_LOG);
  if (fs.existsSync(file)) checkPath(file);
  if (session === undefined) fs.writeFileSync(file, '', { mode: 0o600 });
  else fs.appendFileSync(file, session + '\n');
  syncFile(file);
}

export function cutover(
  root: string,
  mode: Mode,
  progress: Progress = () => {},
): { mode: Mode; sessions: number; files: number; phase: string } {
  root = path.resolve(root);
  checkPath(root, true);
  const liveRoot = fs.existsSync(DATA_DIR) ? fs.realpathSync(DATA_DIR) : path.resolve(DATA_DIR);
  if (fs.realpathSync(root) !== root || root === liveRoot || root.startsWith(liveRoot + path.sep))
    throw new Error('Refusing live DATA_DIR or aliases; provide a separate offline staging copy');
  const names = discoverSessionFiles(root);
  const groups = sessionGroups(names);
  const result = (phase: string) => ({ mode, sessions: groups.length, files: names.length, phase });
  const manifestPath = path.join(root, CONVERSATION_CUTOVER_MANIFEST);
  let manifest: Manifest | undefined;
  if (fs.existsSync(path.dirname(manifestPath))) {
    checkPath(path.dirname(manifestPath), true);
    if (!fs.existsSync(manifestPath))
      throw new Error(
        'Cutover directory has no manifest; retain it for inspection and use a new coherent staging copy',
      );
  }
  if (fs.existsSync(manifestPath)) {
    checkPath(manifestPath);
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    if (manifest.version !== MANIFEST_VERSION)
      throw new Error('Manifest written by an incompatible migrator version; use a new coherent staging copy');
    if (!Array.isArray(manifest.files) || JSON.stringify(manifest.files.map((f) => f.name)) !== JSON.stringify(names))
      throw new Error('Manifest scope mismatch; refuse partial or changed session set');
  }
  // Only one session's stores are ever open, so memory is bounded by the largest session.
  const eachSession = (label: string, run: (stores: Store[], session: string) => void) => {
    groups.forEach((files, index) => {
      withSession(root, files, (stores) => run(stores, path.dirname(files[0])));
      if ((index + 1) % 25 === 0 || index + 1 === groups.length)
        progress(`${label}: ${index + 1}/${groups.length} sessions`);
    });
  };
  try {
    if (mode === 'rollback' || mode === 'retry') {
      if (!manifest) throw new Error('No original snapshot to restore');
      eachSession('preflight', () => {});
      if (manifest.phase === 'verified')
        assertFileHashes(root, manifest, names, 'after', 'Verified store changed; refusing to overwrite later writes');
      if (manifest.phase === 'backing-up') completeBackup(root, manifest);
      snapshots(root, manifest, true);
      if (mode === 'rollback') return result(manifest.phase);
    } else if (manifest) {
      if (manifest.phase !== 'verified') throw new Error('Incomplete cutover; use explicit --retry or --rollback');
      snapshots(root, manifest, false);
      assertFileHashes(
        root,
        manifest,
        names,
        'after',
        'Verified store changed; refusing to bless or overwrite later writes',
      );
      const verified = manifest;
      eachSession('verify', (stores) => verify(root, stores, verified));
      return result('verified');
    } else if (mode === 'verify')
      throw new Error('No cutover manifest; verification cannot certify an untracked migration');

    // Every session must pass before anything persistent is written.
    const baseline: FileSnapshot[] = [];
    eachSession('preflight', (stores) => {
      sessionEvidence(stores);
      for (const { db } of stores) {
        if (
          has(db, 'conversation_sync_migrations') &&
          db.query("SELECT 1 FROM conversation_sync_migrations WHERE step='backfill:1'").get()
        )
          throw new Error('Preexisting untracked backfill; restore the coordinated pre-cutover snapshot');
      }
      if (!manifest && mode === 'apply')
        for (const store of stores)
          baseline.push({ name: store.name, before: fileHash(store.file), tables: preserve(store.db) });
    });
    if (mode === 'dry-run') return result('preflight-ok');
    if (!manifest) {
      manifest = {
        version: MANIFEST_VERSION,
        phase: 'backing-up',
        files: baseline.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      };
      fs.mkdirSync(path.dirname(manifestPath), { mode: 0o700 });
      syncFile(root);
      saveManifest(root, manifest);
      completeBackup(root, manifest);
    }
    const active = manifest;
    active.phase = 'applying';
    saveManifest(root, active);
    recordProgress(root);
    eachSession('apply', (stores, session) => {
      // Checked under this session's exclusive locks: migrate exactly what was backed up.
      assertFileHashes(
        root,
        active,
        stores.map((s) => s.name),
        'before',
        'Store changed since backup; use explicit --retry or --rollback',
      );
      const { outputs, inputs, shared } = sessionEvidence(stores);
      for (const store of outputs) {
        backfillTurns(store.db, inputs, shared);
        if (store.name.endsWith('runner-state.db')) migrateRunnerTurnJournal(store.db);
        store.db.exec('COMMIT');
      }
      recordProgress(root, session);
    });
    active.phase = 'verifying';
    saveManifest(root, active);
    eachSession('verify', (stores) => verify(root, stores, active));
    for (const file of active.files) file.after = fileHash(path.join(root, file.name));
    active.phase = 'verified';
    saveManifest(root, active);
    return result(active.phase);
  } catch (error) {
    if (manifest && !['verified', 'rolled-back', 'backing-up'].includes(manifest.phase)) {
      manifest.phase = 'failed';
      saveManifest(root, manifest);
    }
    throw error;
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        'staging-data-dir': { type: 'string' },
        'attest-offline-copy': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        apply: { type: 'boolean' },
        verify: { type: 'boolean' },
        retry: { type: 'boolean' },
        rollback: { type: 'boolean' },
      },
      strict: true,
    });
    if (!values['staging-data-dir'] || !values['attest-offline-copy'])
      throw new Error('Require --staging-data-dir and --attest-offline-copy; read docs/conversation-cutover.md');
    const modes = (['apply', 'verify', 'retry', 'rollback', 'dry-run'] as const).filter((m) => values[m]);
    if (modes.length > 1) throw new Error('Choose only one mode');
    console.log(
      JSON.stringify(cutover(values['staging-data-dir'], modes[0] ?? 'dry-run', (message) => console.error(message))),
    );
  } catch (error) {
    // Never print rows, env, credential-bearing config, or raw SQLite diagnostics.
    console.error(
      error instanceof Error && !('code' in error) ? error.message : 'SQLite/file preflight or migration failed',
    );
    process.exitCode = 1;
  }
}
