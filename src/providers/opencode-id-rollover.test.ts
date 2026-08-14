import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repairOpencodeIdRollover } from './opencode-id-rollover.js';

/** Encode a message ID the way OpenCode's Identifier does (6-byte truncation). */
function mintId(atMs: number, counter = 1): string {
  const packed = (BigInt(atMs) * 4096n + BigInt(counter)) & 0xffff_ffff_ffffn;
  return `msg_${packed.toString(16).padStart(12, '0')}${'a'.repeat(14)}`;
}

const ROLLOVER_MS = 2 ** 36;

let dir: string;

function makeDb(): string {
  const dbPath = path.join(dir, 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.close();
  return dbPath;
}

function insert(dbPath: string, id: string, sessionId: string, createdAt: number, data: object) {
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?)`).run(
    id,
    sessionId,
    createdAt,
    createdAt,
    JSON.stringify(data),
  );
  db.close();
}

function finishOf(dbPath: string, id: string): string | null {
  const db = new Database(dbPath);
  const row = db
    .prepare<
      [string],
      { finish: string | null }
    >(`SELECT json_extract(data, '$.finish') AS finish FROM message WHERE id = ?`)
    .get(id);
  db.close();
  return row?.finish ?? null;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rollover-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('repairOpencodeIdRollover', () => {
  it('clears finish on a trailing assistant message minted before the last rollover', () => {
    const dbPath = makeDb();
    const preRollover = Date.now() - ROLLOVER_MS / 2;
    insert(dbPath, mintId(preRollover), 'ses_a', preRollover, { role: 'assistant', finish: 'stop' });

    repairOpencodeIdRollover(dir);

    expect(finishOf(dbPath, mintId(preRollover))).toBeNull();
  });

  it('leaves sessions whose trailing assistant message is post-rollover alone', () => {
    const dbPath = makeDb();
    const recent = Date.now() - 60_000;
    insert(dbPath, mintId(recent), 'ses_a', recent, { role: 'assistant', finish: 'stop' });

    repairOpencodeIdRollover(dir);

    expect(finishOf(dbPath, mintId(recent))).toBe('stop');
  });

  it('only touches the newest assistant message of an affected session', () => {
    const dbPath = makeDb();
    const older = Date.now() - ROLLOVER_MS / 2 - 1000;
    const newest = Date.now() - ROLLOVER_MS / 2;
    insert(dbPath, mintId(older), 'ses_a', older, { role: 'assistant', finish: 'stop' });
    insert(dbPath, mintId(newest), 'ses_a', newest, { role: 'assistant', finish: 'stop' });

    repairOpencodeIdRollover(dir);

    expect(finishOf(dbPath, mintId(older))).toBe('stop');
    expect(finishOf(dbPath, mintId(newest))).toBeNull();
  });

  it('is a no-op when there is no OpenCode database yet', () => {
    expect(() => repairOpencodeIdRollover(dir)).not.toThrow();
  });
});
