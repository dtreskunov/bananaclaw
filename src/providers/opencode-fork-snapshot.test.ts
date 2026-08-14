/**
 * The snapshot is the load-bearing half of a native OpenCode fork: it runs
 * against a database another process may be writing, and its failure modes
 * (a torn copy, an unbounded copy) are far worse than declining. These tests
 * pin the consistency guarantee and the size guard.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cloneOpencodeSessionState } from './opencode-fork-snapshot.js';

let root: string;
let parentDir: string;
let forkDir: string;

function opencodeRoot(sessionDir: string): string {
  return path.join(sessionDir, 'opencode-xdg', 'opencode');
}

/** A WAL-mode DB with committed rows still sitting in the -wal file. */
function seedParentDb(): string {
  const dir = opencodeRoot(parentDir);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT)');
  const insert = db.prepare('INSERT INTO message (id, data) VALUES (?, ?)');
  for (let i = 0; i < 50; i++) insert.run(`msg-${i}`, `body ${i}`);
  // Deliberately left open, as a live session's server would: the committed
  // rows are only in the WAL, so a plain file copy would lose them.
  return dbPath;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-oc-fork-'));
  parentDir = path.join(root, 'sess-parent');
  forkDir = path.join(root, 'sess-fork');
  fs.mkdirSync(forkDir, { recursive: true });
});

afterEach(() => {
  delete process.env.OPENCODE_FORK_MAX_DB_BYTES;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cloneOpencodeSessionState', () => {
  it('copies rows that are still only in the parent write-ahead log', () => {
    seedParentDb();

    expect(cloneOpencodeSessionState(parentDir, forkDir)).toBe(true);

    const snapshot = path.join(opencodeRoot(forkDir), 'opencode.db');
    const db = new Database(snapshot, { readonly: true });
    try {
      expect((db.prepare('SELECT COUNT(*) AS c FROM message').get() as { c: number }).c).toBe(50);
    } finally {
      db.close();
    }
    // A standalone file, not a DB that needs the parent's sidecars to read.
    expect(fs.existsSync(`${snapshot}-wal`)).toBe(false);
  });

  it('leaves the parent untouched', () => {
    const parentDb = seedParentDb();
    const before = fs.statSync(parentDb).mtimeMs;

    cloneOpencodeSessionState(parentDir, forkDir);

    expect(fs.statSync(parentDb).mtimeMs).toBe(before);
    const db = new Database(parentDb, { readonly: true });
    try {
      expect((db.prepare('SELECT COUNT(*) AS c FROM message').get() as { c: number }).c).toBe(50);
    } finally {
      db.close();
    }
  });

  it('carries the sidecar storage the server expects next to the DB', () => {
    seedParentDb();
    const storage = path.join(opencodeRoot(parentDir), 'storage', 'session_diff');
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'ses_1.json'), '{}');

    cloneOpencodeSessionState(parentDir, forkDir);

    expect(fs.existsSync(path.join(opencodeRoot(forkDir), 'storage', 'session_diff', 'ses_1.json'))).toBe(true);
  });

  it('declines rather than duplicating a database over the limit', () => {
    seedParentDb();
    process.env.OPENCODE_FORK_MAX_DB_BYTES = '1';

    expect(cloneOpencodeSessionState(parentDir, forkDir)).toBe(false);
    expect(fs.existsSync(path.join(opencodeRoot(forkDir), 'opencode.db'))).toBe(false);
  });

  it('declines when the parent never ran on OpenCode', () => {
    expect(cloneOpencodeSessionState(parentDir, forkDir)).toBe(false);
  });

  it('leaves no half-written snapshot behind when the copy fails', () => {
    const dir = opencodeRoot(parentDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.db'), 'this is not a database');

    expect(cloneOpencodeSessionState(parentDir, forkDir)).toBe(false);
    expect(fs.existsSync(path.join(opencodeRoot(forkDir), 'opencode.db'))).toBe(false);
  });
});
