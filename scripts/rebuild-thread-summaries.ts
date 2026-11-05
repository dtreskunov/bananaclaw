import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { DATA_DIR } from '../src/config.js';
import { initDb, closeDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { rebuildThreadSummaries } from '../src/thread-summaries.js';
import { log } from '../src/log.js';

if (process.argv.slice(2).join(' ') !== '--host-stopped')
  throw new Error('Stop this checkout host, back up data/, then pass --host-stopped to rebuild thread summaries.');
await new Promise<void>((resolve, reject) => {
  const socket = net.createConnection(path.join(DATA_DIR, 'ncl.sock'));
  socket.setTimeout(1000);
  socket.once('connect', () => {
    socket.destroy();
    reject(new Error('The host CLI socket is active. Stop this checkout host before backfill.'));
  });
  socket.once('timeout', () => {
    socket.destroy();
    reject(new Error('Could not confirm the host is stopped.'));
  });
  socket.once('error', (error: NodeJS.ErrnoException) => {
    socket.destroy();
    if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve();
    else reject(error);
  });
});
fs.accessSync(path.join(DATA_DIR, 'v2.db'));
try {
  runMigrations(initDb(path.join(DATA_DIR, 'v2.db')));
  rebuildThreadSummaries();
  log.info('Thread summary backfill complete');
} finally {
  await Promise.resolve();
  closeDb();
}
