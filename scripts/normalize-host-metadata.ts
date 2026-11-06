import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../src/config.js';
import { epochMs, parseTimestamp } from '../src/time.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host metadata object');
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Invalid host metadata collection');
  return value.map(object);
}

async function assertHostStopped(dataDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(path.join(dataDir, 'ncl.sock'));
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Stop the host before normalizing metadata'));
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

export async function normalizeHostMetadata(dataDir: string, backupDir: string): Promise<number> {
  await assertHostStopped(dataDir);
  const plans: { file: string; relative: string; contents: string; mode: number }[] = [];
  for (const relative of ['circuit-breaker.json', 'telegram-pairings.json', 'skills/marketplaces.json']) {
    const file = path.join(dataDir, relative);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Metadata must be a regular file: ${file}`);
    const value = object(JSON.parse(fs.readFileSync(file, 'utf8')));
    let converted = 0;
    const instant = (row: Record<string, unknown>, key: string, nullable = false) => {
      if (row[key] === null && nullable) return;
      if (typeof row[key] === 'string') {
        row[key] = parseTimestamp(row[key]);
        converted++;
      } else epochMs(row[key]);
    };
    if (relative === 'circuit-breaker.json') instant(value, 'timestamp');
    else if (relative === 'telegram-pairings.json') {
      for (const row of records(value.pairings)) {
        instant(row, 'createdAt');
        if (row.consumed) instant(object(row.consumed), 'consumedAt');
        if (row.attempts) for (const attempt of records(row.attempts)) instant(attempt, 'at');
      }
    } else {
      for (const row of records(value.sources)) {
        instant(row, 'addedAt');
        instant(row, 'refreshedAt', true);
        if (row.lastRefreshAttemptAt !== undefined) instant(row, 'lastRefreshAttemptAt', true);
      }
    }
    if (converted)
      plans.push({ file, relative, contents: JSON.stringify(value, null, 2) + '\n', mode: stat.mode & 0o777 });
  }
  for (const plan of plans) {
    const backup = path.join(backupDir, plan.relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.copyFileSync(plan.file, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
  }
  for (const plan of plans) {
    const temporary = `${plan.file}.normalize-${process.pid}`;
    try {
      fs.writeFileSync(temporary, plan.contents, { flag: 'wx', mode: plan.mode });
      fs.renameSync(temporary, plan.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return plans.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--host-stopped' || !process.argv[3] || process.argv.length !== 4)
    throw new Error('Usage: normalize-host-metadata.ts --host-stopped <new-backup-directory>');
  console.log(`Normalized ${await normalizeHostMetadata(DATA_DIR, path.resolve(process.argv[3]))} metadata files`);
}
