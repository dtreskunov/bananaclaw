import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { log } from '../log.js';

const DEFAULT_MAX_DB_BYTES = 100 * 1024 * 1024;

function maxDbBytes(): number {
  const raw = Number(process.env.NATIVE_FORK_MAX_DB_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DB_BYTES;
}

export function cloneNativeSessionState(parentSessionDir: string, newSessionDir: string): boolean {
  const source = path.join(parentSessionDir, 'native-state.db');
  if (!fs.existsSync(source)) return false;

  const size = fs.statSync(source).size;
  const limit = maxDbBytes();
  if (size > limit) {
    log.warn('Fork: native session DB over the snapshot limit; using a history digest', { source, size, limit });
    return false;
  }

  const destination = path.join(newSessionDir, 'native-state.db');
  fs.mkdirSync(newSessionDir, { recursive: true });
  let db: Database.Database | undefined;
  try {
    db = new Database(source, { readonly: true });
    fs.rmSync(destination, { force: true });
    db.prepare('VACUUM INTO ?').run(destination);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- snapshot failure degrades to the existing digest fork
  } catch (error) {
    log.warn('Fork: failed to snapshot native session DB', { source, error });
    fs.rmSync(destination, { force: true });
    return false;
  } finally {
    db?.close();
  }
}
