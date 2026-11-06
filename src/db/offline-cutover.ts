import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { convertStoreTimes, STORAGE_VERSION } from './storage-lifecycle.js';
import { migrateSearchStorage } from '../search-index.js';
import { migrations, runMigrations } from './migrations/index.js';

type StoreKind = 'central' | 'inbound' | 'outbound' | 'runner-state' | 'native' | 'search';
export interface StorePath {
  kind: StoreKind;
  path: string;
}
const definitions: Record<StoreKind, { anchor: string; version: number }> = {
  central: { anchor: 'schema_version', version: STORAGE_VERSION },
  inbound: { anchor: 'pending_host_events', version: STORAGE_VERSION },
  outbound: { anchor: 'applied_runner_events', version: STORAGE_VERSION },
  'runner-state': { anchor: 'pending_runner_events', version: STORAGE_VERSION },
  native: { anchor: 'conversations', version: STORAGE_VERSION },
  search: { anchor: 'message_index', version: 2 },
};

interface PreparedStore {
  source: string;
  backup: string;
  candidate: string;
  kind: StoreKind;
  rowCounts: Record<string, number>;
}

function counts(db: Database.Database, kind: StoreKind): PreparedStore['rowCounts'] {
  // FTS internals and the migration ledger may grow during a valid upgrade.
  const tables =
    kind === 'search'
      ? [{ name: 'message_index' }]
      : (db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>);
  return Object.fromEntries(
    tables
      .filter(({ name }) => kind !== 'central' || name !== 'schema_version')
      .map(({ name }) => [
        name,
        (db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n,
      ]),
  );
}

function verifyIntegrity(db: Database.Database, phase: string, source: string): void {
  if ((db.pragma('foreign_key_check') as unknown[]).length)
    throw new Error(`${phase} foreign-key violations: ${source}`);
  if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error(`${phase} integrity failure: ${source}`);
}

async function backupStore(kind: StoreKind, source: string, backup: string): Promise<PreparedStore> {
  if (!Object.hasOwn(definitions, kind)) throw new Error(`Unknown store kind: ${kind}`);
  const candidate = `${source}.epoch-candidate`;
  if (fs.existsSync(candidate)) throw new Error(`Candidate already exists: ${candidate}`);
  const db = new Database(source, { fileMustExist: true });
  try {
    const version = db.pragma('user_version', { simple: true });
    const definition = definitions[kind];
    if (version !== 0 && version !== STORAGE_VERSION && version !== definition.version)
      throw new Error(`Unknown storage version ${version}: ${source}`);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(definition.anchor))
      throw new Error(`Not a ${kind} store: ${source}`);
    verifyIntegrity(db, 'Preflight', source);
    const rowCounts = counts(db, kind);
    await db.backup(backup);
    fs.chmodSync(backup, 0o600);
    return { source, backup, candidate, kind, rowCounts };
  } finally {
    db.close();
  }
}

function convertCandidate(store: PreparedStore): void {
  const db = new Database(store.candidate);
  try {
    db.pragma('journal_mode=DELETE');
    if (store.kind === 'central') {
      runMigrations(db, [...migrations]);
    }
    if (store.kind === 'search') migrateSearchStorage(db);
    else convertStoreTimes(db);
    if (JSON.stringify(counts(db, store.kind)) !== JSON.stringify(store.rowCounts))
      throw new Error(`Row counts changed: ${store.source}`);
    verifyIntegrity(db, 'Candidate', store.source);
  } finally {
    db.close();
  }
}

function activateStores(stores: PreparedStore[], backupDirectory: string): void {
  // Never delete a journal belonging to a process that ignored the stop requirement.
  for (const { source } of stores)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(source + suffix)) throw new Error(`Store is not quiescent: ${source + suffix}`);
    }
  fs.writeFileSync(
    path.join(backupDirectory, 'manifest.json'),
    JSON.stringify(
      {
        formatVersion: 1,
        stores: stores.map(({ source, backup, kind, rowCounts }) => ({
          source,
          backup,
          kind,
          rowCounts,
          storageVersion: definitions[kind].version,
        })),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const replaced: PreparedStore[] = [];
  try {
    for (const item of stores) {
      fs.renameSync(item.candidate, item.source);
      replaced.push(item);
    }
  } catch (error) {
    for (const item of replaced) fs.copyFileSync(item.backup, item.source);
    throw error;
  }
}

/**
 * Never called by startup. Every path is operator-supplied; host runtime never
 * opens runner/native files. Candidates are verified before any file is replaced.
 */
export async function cutoverStores(
  stores: StorePath[],
  backupDirectory: string,
  stopped: { serviceStopped: boolean; runnersStopped: boolean },
): Promise<void> {
  if (!stopped.serviceStopped || !stopped.runnersStopped)
    throw new Error('Explicit stopped host AND runners acknowledgements are required');
  if (!stores.length) throw new Error('An explicit store inventory is required');
  const paths = stores.map((store) => fs.realpathSync(store.path));
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate store path');
  if (fs.existsSync(backupDirectory)) throw new Error('Backup directory must not already exist');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const prepared: PreparedStore[] = [];
  try {
    for (const [index, store] of stores.entries()) {
      const backup = path.resolve(backupDirectory, `${index}-${store.kind}.db`);
      const item = await backupStore(store.kind, paths[index], backup);
      fs.copyFileSync(item.backup, item.candidate, fs.constants.COPYFILE_EXCL);
      prepared.push(item);
      convertCandidate(item);
    }
    activateStores(prepared, backupDirectory);
  } finally {
    for (const { candidate } of prepared) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}
