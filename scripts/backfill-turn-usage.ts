import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Options {
  source: string;
  output: string;
  hostStopped: boolean;
  runnersStopped: boolean;
}
interface Store {
  relative: string;
  kind: 'central' | 'inbound' | 'outbound' | 'runner';
}
interface UsageFact {
  id: string;
  tokens: number | null;
  source: string | null;
}
const OLD_VERSION = 2;
const NEW_VERSION = 3;
const costSources = ['reported', 'estimated', 'unavailable', 'mixed'];

function checkDatabase(db: Database.Database, version: number, label: string): void {
  if (db.pragma('user_version', { simple: true }) !== version)
    throw new Error(`${label}: expected storage version ${version}`);
  const foreignKeys = db.pragma('foreign_key_check');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || !Array.isArray(foreignKeys) || foreignKeys.length)
    throw new Error(`${label}: SQLite integrity/foreign-key validation failed`);
}

async function assertHostStopped(source: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(path.join(source, 'ncl.sock'));
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Host CLI socket is active; stop the host before taking a cutover snapshot'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Could not confirm the host is stopped'));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

function addUsageColumns(db: Database.Database): void {
  const columns = db.pragma('table_info(turn_usage)') as { name: string }[];
  if (!columns.some(({ name }) => name === 'reported_tokens'))
    db.exec(`ALTER TABLE turn_usage ADD COLUMN reported_tokens INTEGER CHECK (reported_tokens IS NULL OR
      (typeof(reported_tokens)='integer' AND reported_tokens BETWEEN 0 AND 9007199254740991))`);
  if (!columns.some(({ name }) => name === 'cost_source'))
    db.exec(`ALTER TABLE turn_usage ADD COLUMN cost_source TEXT
      CHECK (cost_source IS NULL OR cost_source IN ('reported','estimated','unavailable','mixed'))`);
}

function preserveObservedFacts(db: Database.Database): UsageFact[] {
  const facts: UsageFact[] = [];
  const rows = db
    .prepare(
      `SELECT key,value FROM session_state WHERE key LIKE 'turn-metadata:%'
    AND json_valid(value) AND (json_type(value,'$.reportedTokens') IS NOT NULL
      OR json_type(value,'$.costSource') IS NOT NULL)`,
    )
    .all() as { key: string; value: string }[];
  for (const row of rows) {
    const metadata: Record<string, unknown> = JSON.parse(row.value);
    const tokens = metadata.reportedTokens ?? null;
    const source = metadata.costSource ?? null;
    if (tokens !== null && (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0))
      throw new Error(`${row.key}: invalid explicit token measurement`);
    if (source !== null && (typeof source !== 'string' || !costSources.includes(source)))
      throw new Error(`${row.key}: invalid explicit cost source`);
    if (tokens !== null || source !== null) {
      if (typeof metadata.usageId !== 'string') throw new Error(`${row.key}: measurement has no usage identity`);
      const usage = db.prepare('SELECT turn_id FROM turn_usage WHERE id=?').get(metadata.usageId) as
        | { turn_id: string }
        | undefined;
      if (!usage || row.key !== `turn-metadata:${usage.turn_id}`)
        throw new Error(`${row.key}: measurement has no matching usage record`);
      db.prepare('UPDATE turn_usage SET reported_tokens=?,cost_source=? WHERE id=?').run(
        tokens,
        source,
        metadata.usageId,
      );
      facts.push({ id: metadata.usageId, tokens, source });
    }
    delete metadata.reportedTokens;
    delete metadata.costSource;
    db.prepare('UPDATE session_state SET value=? WHERE key=?').run(JSON.stringify(metadata), row.key);
  }
  return facts;
}

function copyObservedUsage(runner: Database.Database, host: Database.Database, facts: UsageFact[]): number {
  let inserted = 0;
  for (const fact of facts) {
    const row = runner.prepare('SELECT * FROM turn_usage WHERE id=?').get(fact.id) as Record<string, unknown>;
    if (!host.prepare('SELECT 1 FROM turns WHERE id=?').get(row.turn_id))
      throw new Error(`${fact.id}: host has no matching turn; manual reconciliation required`);
    if (row.message_out_id !== null && !host.prepare('SELECT 1 FROM messages_out WHERE id=?').get(row.message_out_id))
      throw new Error(`${fact.id}: host has no matching output; manual reconciliation required`);
    const existing = host.prepare('SELECT * FROM turn_usage WHERE id=?').get(fact.id) as
      | Record<string, unknown>
      | undefined;
    const columns = Object.keys(row);
    if (existing) {
      if (columns.some((key) => !['reported_tokens', 'cost_source'].includes(key) && existing[key] !== row[key]))
        throw new Error(`${fact.id}: host and runner usage disagree; manual reconciliation required`);
      host
        .prepare('UPDATE turn_usage SET reported_tokens=?,cost_source=? WHERE id=?')
        .run(fact.tokens, fact.source, fact.id);
    } else {
      const quoted = columns.map((key) => `"${key.replaceAll('"', '""')}"`).join(',');
      host
        .prepare(`INSERT INTO turn_usage (${quoted}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...Object.values(row));
      inserted++;
    }
    const key = `turn-metadata:${row.turn_id}`;
    const metadata = runner.prepare('SELECT value,updated_at FROM session_state WHERE key=?').get(key) as {
      value: string;
      updated_at: number;
    };
    const prior = host.prepare('SELECT value FROM session_state WHERE key=?').pluck().get(key) as string | undefined;
    if (prior) {
      const previous: Record<string, unknown> = JSON.parse(prior);
      if (previous.usageId !== null && previous.usageId !== fact.id)
        throw new Error(`${fact.id}: host metadata references another usage record`);
    }
    host
      .prepare(
        `INSERT INTO session_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      )
      .run(key, metadata.value, metadata.updated_at);
  }
  return inserted;
}

export async function backfillTurnUsage(options: Options) {
  if (!options.hostStopped || !options.runnersStopped)
    throw new Error('Require --host-stopped AND --runners-stopped; this tool does not stop writers or install files');
  const source = fs.realpathSync(options.source);
  const output = path.resolve(options.output);
  if (output === source || output.startsWith(source + path.sep) || source.startsWith(output + path.sep))
    throw new Error('Output must be outside the source directory');
  if (fs.existsSync(output)) throw new Error('Output must be a new directory');
  await assertHostStopped(source);

  const central = new Database(path.join(source, 'v2.db'), { readonly: true });
  let sessions: { id: string; agent_group_id: string }[];
  try {
    checkDatabase(central, OLD_VERSION, 'central');
    sessions = central.prepare('SELECT id,agent_group_id FROM sessions ORDER BY id').all() as typeof sessions;
  } finally {
    central.close();
  }
  const stores: Store[] = [{ relative: 'v2.db', kind: 'central' }];
  for (const session of sessions) {
    for (const id of [session.id, session.agent_group_id])
      if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) throw new Error('Invalid session path component');
    const relative = path.join('v2-sessions', session.agent_group_id, session.id);
    stores.push(
      { relative: path.join(relative, 'inbound.db'), kind: 'inbound' },
      { relative: path.join(relative, 'outbound.db'), kind: 'outbound' },
      { relative: path.join(relative, 'runner-state', 'runner-state.db'), kind: 'runner' },
    );
  }
  let bytes = 0;
  for (const store of stores) {
    const filename = path.join(source, store.relative);
    if (!fs.statSync(filename).isFile() || !fs.realpathSync(filename).startsWith(source + path.sep))
      throw new Error(`${store.relative}: expected a private database inside source`);
    bytes += fs.statSync(filename).size;
    const db = new Database(filename, { readonly: true });
    try {
      checkDatabase(db, OLD_VERSION, store.relative);
      if (
        store.kind === 'runner' &&
        db.prepare("SELECT 1 FROM sqlite_schema WHERE name='pending_runner_events'").get() &&
        db.prepare('SELECT 1 FROM pending_runner_events LIMIT 1').get()
      )
        throw new Error(`${store.relative}: runner journal is not drained; drain with the old runtime before cutover`);
    } finally {
      db.close();
    }
  }
  const disk = fs.statfsSync(path.dirname(output));
  if (disk.bavail * disk.bsize < bytes * 2 + 128 * 1024 * 1024)
    throw new Error('Insufficient disk space for complete backups and candidates');
  fs.mkdirSync(output, { mode: 0o700 });
  const candidate = path.join(output, 'candidate');
  const observed = new Map<string, UsageFact[]>();
  const manifest = {
    complete: false,
    source,
    fromVersion: OLD_VERSION,
    toVersion: NEW_VERSION,
    preservedMeasurements: 0,
    restoredHostUsageRows: 0,
    stores: [] as { relative: string; sha256: string }[],
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  for (const [index, store] of stores.entries()) {
    const backup = path.join(output, 'backup', store.relative);
    const target = path.join(candidate, store.relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const original = new Database(path.join(source, store.relative), { readonly: true });
    try {
      await original.backup(backup);
    } finally {
      original.close();
    }
    fs.chmodSync(backup, 0o600);
    fs.copyFileSync(backup, target);
    const db = new Database(target);
    try {
      db.pragma('journal_mode = DELETE');
      db.pragma('foreign_keys = ON');
      db.transaction(() => {
        if (store.kind === 'central') {
          if (
            !db
              .prepare("SELECT 1 FROM pragma_table_info('container_configs') WHERE name='soft_turn_token_budget'")
              .get()
          )
            db.exec(`ALTER TABLE container_configs ADD COLUMN soft_turn_token_budget INTEGER CHECK (soft_turn_token_budget IS NULL OR
              (typeof(soft_turn_token_budget)='integer' AND soft_turn_token_budget>0 AND soft_turn_token_budget<=9007199254740991))`);
        } else if (store.kind !== 'inbound') {
          if (store.kind === 'runner') {
            const triggers = db
              .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'journal_%'")
              .all() as { name: string }[];
            for (const { name } of triggers) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
          }
          addUsageColumns(db);
          const facts = preserveObservedFacts(db);
          if (store.kind === 'runner') observed.set(path.dirname(path.dirname(store.relative)), facts);
        }
        db.pragma(`user_version=${NEW_VERSION}`);
      })();
      checkDatabase(db, NEW_VERSION, store.relative);
    } finally {
      db.close();
    }
    if ((index + 1) % 100 === 0) console.log(`Prepared ${index + 1}/${stores.length} databases`);
  }
  for (const [relative, facts] of observed) {
    if (!facts.length) continue;
    const host = new Database(path.join(candidate, relative, 'outbound.db'));
    const runner = new Database(path.join(candidate, relative, 'runner-state', 'runner-state.db'), { readonly: true });
    try {
      host.pragma('foreign_keys = ON');
      manifest.restoredHostUsageRows += host.transaction(() => copyObservedUsage(runner, host, facts))();
      manifest.preservedMeasurements += facts.length;
    } finally {
      runner.close();
      host.close();
    }
  }
  for (const store of stores) {
    const filename = path.join(candidate, store.relative);
    const db = new Database(filename, { readonly: true });
    try {
      checkDatabase(db, NEW_VERSION, store.relative);
    } finally {
      db.close();
    }
    manifest.stores.push({
      relative: store.relative,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
    });
  }
  manifest.complete = true;
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = process.argv.slice(2);
  const flags = new Map<string, string | boolean>();
  while (values.length) {
    const key = values.shift()!;
    if (key === '--host-stopped' || key === '--runners-stopped') flags.set(key, true);
    else if (key === '--source' || key === '--output') {
      const value = values.shift();
      if (!value || value.startsWith('--')) throw new Error(`${key} requires a path`);
      flags.set(key, value);
    } else throw new Error(`Unknown argument: ${key}`);
  }
  const source = flags.get('--source');
  const output = flags.get('--output');
  if (typeof source !== 'string' || typeof output !== 'string') throw new Error('--source and --output are required');
  const result = await backfillTurnUsage({
    source,
    output,
    hostStopped: flags.get('--host-stopped') === true,
    runnersStopped: flags.get('--runners-stopped') === true,
  });
  console.log(
    JSON.stringify({
      complete: result.complete,
      databases: result.stores.length,
      preservedMeasurements: result.preservedMeasurements,
      restoredHostUsageRows: result.restoredHostUsageRows,
      manifest: path.join(path.resolve(output), 'manifest.json'),
    }),
  );
}
