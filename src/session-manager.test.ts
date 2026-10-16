/**
 * Tests for session-manager's direct outbound write path.
 *
 * Drives the real `writeOutboundDirect` entry against a real session folder
 * on disk. A previous implementation opened the outbound DB through
 * `openOutboundDb` (readonly: true), so every INSERT threw SQLITE_READONLY
 * and the command-gate denial path silently never delivered. Goes red if the
 * open call reverts to the readonly form.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '.test-write-outbound' };
});

import {
  initSessionFolder,
  outboundDbPath,
  writeOutboundDirect,
  seedRunnerState,
  runnerStateDbPath,
} from './session-manager.js';
import { putTurn } from './db/turns.js';
import { stopSessionSignalServer } from './session-link.js';

const TEST_DIR = '.test-write-outbound';
const AG = 'ag-test';
const SESS = 'sess-test';

function readMessagesOut(): Array<{ id: string; seq: number; kind: string; content: string }> {
  const db = new Database(outboundDbPath(AG, SESS), { readonly: true });
  try {
    return db.prepare('SELECT id, seq, kind, content FROM messages_out ORDER BY seq').all() as Array<{
      id: string;
      seq: number;
      kind: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await stopSessionSignalServer(SESS, true);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('writeOutboundDirect', () => {
  it('opens a fresh host-projection seed in the real Bun runner without replaying copied history', () => {
    const db = new Database(outboundDbPath(AG, SESS));
    putTurn(db, {
      id: 'seed-turn',
      phase: 'settled',
      outcome: 'silent',
      provenance: 'native',
      origin_channel_type: 'web',
      origin_platform_id: 'chat',
      origin_thread_id: null,
      origin_source_session_id: null,
      started_at: 'original start',
      ended_at: 'original end',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    });
    db.prepare(`INSERT INTO turn_usage (id,turn_id,input_tokens) VALUES ('seed-bill','seed-turn',17)`).run();
    db.close();
    seedRunnerState(AG, SESS, true);
    const result = execFileSync(
      'bun',
      [
        '--eval',
        `
      import { Database } from 'bun:sqlite';
      import { ensureRunnerStateSchema } from './container/agent-runner/src/db/runner-state.ts';
      const db = new Database(${JSON.stringify(runnerStateDbPath(AG, SESS))});
      db.exec('PRAGMA foreign_keys=ON');
      ensureRunnerStateSchema(db);
      ensureRunnerStateSchema(db);
      console.log(JSON.stringify({
        turns: db.query('SELECT id,phase,outcome FROM turns').all(),
        usage: db.query('SELECT id,turn_id,input_tokens FROM turn_usage').all(),
        journal: db.query('SELECT * FROM pending_runner_events').all(),
        foreignKeys: db.query('PRAGMA foreign_key_check').all(),
      }));
      db.close();
    `,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(result)).toEqual({
      turns: [{ id: 'seed-turn', phase: 'settled', outcome: 'silent' }],
      usage: [{ id: 'seed-bill', turn_id: 'seed-turn', input_tokens: 17 }],
      journal: [],
      foreignKeys: [],
    });
    const bytes = fs.readFileSync(runnerStateDbPath(AG, SESS));
    seedRunnerState(AG, SESS);
    expect(fs.readFileSync(runnerStateDbPath(AG, SESS))).toEqual(bytes);
  });
  it('inserts into messages_out with an even host-side seq (requires a writable outbound.db)', () => {
    // With a readonly open this very call throws SQLITE_READONLY.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'Admin commands are restricted.' }),
    });

    const rows = readMessagesOut();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('denial-1');
    expect(rows[0].seq).toBe(2);
    expect(rows[0].seq % 2).toBe(0); // host uses even seq numbers
    expect(JSON.parse(rows[0].content).text).toBe('Admin commands are restricted.');
  });

  it('keeps host seq numbers even across multiple writes and ignores duplicate ids', () => {
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"first"}',
    });
    writeOutboundDirect(AG, SESS, {
      id: 'denial-2',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"second"}',
    });
    // INSERT OR IGNORE — a delivery retry with the same id must not throw or duplicate.
    writeOutboundDirect(AG, SESS, {
      id: 'denial-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{"text":"retry"}',
    });

    const rows = readMessagesOut();
    expect(rows.map((r) => r.id)).toEqual(['denial-1', 'denial-2']);
    expect(rows.map((r) => r.seq)).toEqual([2, 4]);
  });
});
