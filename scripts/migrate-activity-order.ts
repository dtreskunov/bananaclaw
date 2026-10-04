import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../src/config.js';
import { createHash } from 'node:crypto';
import { applyActivityOrder, planActivityOrder } from './activity-order-migration.js';

const { values } = parseArgs({
  options: {
    check: { type: 'boolean' },
    offline: { type: 'boolean' },
    'backup-dir': { type: 'string' },
  },
});
if (!values.check && (!values.offline || !values['backup-dir'])) {
  throw new Error(
    'Stop the host and all runners, back up the session databases, then pass --offline --backup-dir <session-backup-root>.',
  );
}
const root = path.join(DATA_DIR, 'v2-sessions');
const sessions: string[] = [];
for (const group of fs.readdirSync(root, { withFileTypes: true })) {
  if (!group.isDirectory()) continue;
  const groupPath = path.join(root, group.name);
  for (const session of fs.readdirSync(groupPath, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const folder = path.join(groupPath, session.name);
    if (fs.existsSync(path.join(folder, 'outbound.db'))) sessions.push(folder);
  }
}
const inspect = (folder: string) => {
  const databases: Database.Database[] = [];
  try {
    for (const name of ['inbound.db', 'outbound.db', 'runner-state/runner-state.db']) {
      const file = path.join(folder, name);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Session database must be a regular file: ${file}`);
      databases.push(new Database(file, { readonly: true, fileMustExist: true }));
    }
    return planActivityOrder(databases[0], databases[1], databases[2]);
  } catch (error) {
    throw new Error(`Cannot normalize ${folder}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  } finally {
    for (const db of databases) db.close();
  }
};
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let missing = 0;
let activity = 0;
let numericTimestamps = 0;
// Preflight every session before changing any database.
for (const folder of sessions) {
  const plan = inspect(folder);
  if (!plan.needed) continue;
  missing++;
  activity += plan.projections[0].activity.length;
  numericTimestamps += plan.normalizedMessageTimestamps;
  if (!values.check) {
    for (const name of ['inbound.db', 'outbound.db', 'runner-state/runner-state.db']) {
      const file = path.join(folder, name);
      const backup = path.join(values['backup-dir']!, path.relative(root, file));
      if (!fs.existsSync(backup) || hash(file) !== hash(backup)) {
        throw new Error(`Missing or mismatched offline backup: ${backup}`);
      }
    }
  }
}
if (!values.check) {
  for (const folder of sessions) {
    applyActivityOrder(
      path.join(folder, 'outbound.db'),
      path.join(folder, 'runner-state/runner-state.db'),
      inspect(folder),
    );
  }
}
console.log(
  `Checked ${sessions.length} host/runner pairs; ${missing} ${values.check ? 'need conversion' : 'converted'}; ${activity} activity rows.`,
);
console.log(
  `Canonicalized ${numericTimestamps} numeric message-order timestamps; stored display timestamps are unchanged.`,
);
if (values.check && missing) process.exitCode = 1;
