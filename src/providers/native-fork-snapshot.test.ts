import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cloneNativeSessionState } from './native-fork-snapshot.js';

let root: string;
let parentDir: string;
let forkDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-fork-'));
  parentDir = path.join(root, 'parent');
  forkDir = path.join(root, 'fork');
  fs.mkdirSync(parentDir, { recursive: true });
});

afterEach(() => {
  delete process.env.NATIVE_FORK_MAX_DB_BYTES;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cloneNativeSessionState', () => {
  it('creates a consistent standalone snapshot while the parent is open', () => {
    const source = path.join(parentDir, 'native-state.db');
    const parent = new Database(source);
    parent.pragma('journal_mode = DELETE');
    parent.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)');
    parent.prepare('INSERT INTO messages (body) VALUES (?)').run('persisted');

    expect(cloneNativeSessionState(parentDir, forkDir)).toBe(true);
    parent.close();

    const snapshot = new Database(path.join(forkDir, 'native-state.db'), { readonly: true });
    expect(snapshot.prepare('SELECT body FROM messages').pluck().get()).toBe('persisted');
    snapshot.close();
  });

  it('declines snapshots over the configured limit', () => {
    const source = path.join(parentDir, 'native-state.db');
    const parent = new Database(source);
    parent.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY)');
    parent.close();
    process.env.NATIVE_FORK_MAX_DB_BYTES = '1';

    expect(cloneNativeSessionState(parentDir, forkDir)).toBe(false);
    expect(fs.existsSync(path.join(forkDir, 'native-state.db'))).toBe(false);
  });
});
