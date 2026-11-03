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
    const source = path.join(parentDir, 'native-state', 'native-state.db');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const parent = new Database(source);
    parent.pragma('journal_mode = DELETE');
    parent.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)');
    parent.prepare('INSERT INTO messages (body) VALUES (?)').run('persisted');
    const name = `${'a'.repeat(64)}.json`;
    parent.exec('CREATE TABLE tool_results (id TEXT PRIMARY KEY, content_json TEXT NOT NULL)');
    parent.prepare('INSERT INTO tool_results VALUES (?,?)').run(name.slice(0, -5), '{"value":"complete result"}');
    fs.symlinkSync(source, path.join(path.dirname(source), 'tool-results'));

    expect(cloneNativeSessionState(parentDir, forkDir)).toBe(true);
    parent.close();

    const snapshot = new Database(path.join(forkDir, 'native-state', 'native-state.db'), { readonly: true });
    expect(snapshot.prepare('SELECT body FROM messages').pluck().get()).toBe('persisted');
    expect(snapshot.prepare('SELECT content_json FROM tool_results').pluck().get()).toBe('{"value":"complete result"}');
    snapshot.close();
    expect(fs.existsSync(path.join(forkDir, 'native-state/tool-results'))).toBe(false);
  });

  it('includes archived result rows in the existing database size ceiling', () => {
    const source = path.join(parentDir, 'native-state/native-state.db');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const parent = new Database(source);
    parent.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY)');
    parent.exec('CREATE TABLE tool_results (id TEXT PRIMARY KEY, content_json TEXT NOT NULL)');
    parent.prepare('INSERT INTO tool_results VALUES (?,?)').run('result', 'x'.repeat(30_000));
    parent.close();
    process.env.NATIVE_FORK_MAX_DB_BYTES = '20000';
    expect(cloneNativeSessionState(parentDir, forkDir)).toBe(false);
    expect(fs.existsSync(path.join(forkDir, 'native-state/native-state.db'))).toBe(false);
  });

  it('declines snapshots over the configured limit', () => {
    const source = path.join(parentDir, 'native-state', 'native-state.db');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const parent = new Database(source);
    parent.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY)');
    parent.close();
    process.env.NATIVE_FORK_MAX_DB_BYTES = '1';

    expect(cloneNativeSessionState(parentDir, forkDir)).toBe(false);
    expect(fs.existsSync(path.join(forkDir, 'native-state', 'native-state.db'))).toBe(false);
  });
});
