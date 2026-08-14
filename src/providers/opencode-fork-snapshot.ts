/**
 * Snapshot an OpenCode session's server-side state into a forked session.
 *
 * OpenCode keeps conversations in its own SQLite DB under XDG_DATA_HOME, and
 * every nanoclaw session pins that to a private per-session directory. A fork
 * therefore starts with an empty OpenCode data dir, and asking the new
 * session's server to fork the parent's session id would 404 — the native
 * fork only works if the parent's state is physically present in the copy.
 *
 * The snapshot is size-guarded because it is a real duplication: these DBs
 * carry every tool result and pasted image verbatim and routinely reach tens
 * of megabytes, so an unbounded copy would let a few branches of a busy
 * thread fill the host's disk. Over the limit we decline, and the caller
 * falls back to replaying a plain-text digest — a worse branch, but a branch.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { log } from '../log.js';

/** Ceiling on the parent DB we'll duplicate, overridable per install. */
const DEFAULT_MAX_DB_BYTES = 100 * 1024 * 1024;

function maxDbBytes(): number {
  const raw = Number(process.env.OPENCODE_FORK_MAX_DB_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DB_BYTES;
}

/**
 * Copy the parent session's OpenCode state into `newSessionDir`. Returns
 * false when the fork must fall back to the digest — nothing to copy, too
 * large, or the copy failed.
 */
export function cloneOpencodeSessionState(parentSessionDir: string, newSessionDir: string): boolean {
  const srcRoot = path.join(parentSessionDir, 'opencode-xdg', 'opencode');
  const srcDb = path.join(srcRoot, 'opencode.db');
  if (!fs.existsSync(srcDb)) return false;

  const limit = maxDbBytes();
  const size = fs.statSync(srcDb).size;
  if (size > limit) {
    log.warn('Fork: OpenCode session DB over the snapshot limit; using a history digest', { srcDb, size, limit });
    return false;
  }

  const dstRoot = path.join(newSessionDir, 'opencode-xdg', 'opencode');
  const dstDb = path.join(dstRoot, 'opencode.db');
  fs.mkdirSync(dstRoot, { recursive: true });

  let db: Database.Database | undefined;
  try {
    // VACUUM INTO, never a file copy: the parent's server may be mid-turn,
    // and the bytes on disk are only half the DB — the rest is in a WAL we
    // must not interpret ourselves. This takes a read transaction and emits
    // a single self-consistent file, leaving the parent untouched.
    db = new Database(srcDb, { readonly: true });
    fs.rmSync(dstDb, { force: true });
    db.prepare('VACUUM INTO ?').run(dstDb);
    // eslint-disable-next-line no-catch-all/no-catch-all -- any failure here means "no native fork", never a failed fork
  } catch (err) {
    log.warn('Fork: failed to snapshot the OpenCode session DB', { srcDb, err });
    fs.rmSync(dstDb, { force: true });
    return false;
  } finally {
    db?.close();
  }

  // Sidecar state OpenCode keeps next to the DB: schema-migration markers and
  // per-session file diffs. Kilobytes, but without the markers the server
  // would re-run migrations against the copy.
  try {
    const srcStorage = path.join(srcRoot, 'storage');
    if (fs.existsSync(srcStorage)) {
      fs.cpSync(srcStorage, path.join(dstRoot, 'storage'), {
        recursive: true,
        filter: (s) => !fs.lstatSync(s).isSymbolicLink(),
      });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- the DB is the load-bearing part; sidecars are best-effort
  } catch (err) {
    log.warn('Fork: failed to copy OpenCode sidecar storage', { srcRoot, err });
  }

  log.info('Fork: snapshotted OpenCode session state', { bytes: size, dstDb });
  return true;
}
