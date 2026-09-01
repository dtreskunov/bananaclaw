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
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-outbound' };
});

import { initSessionFolder, outboundDbPath, readSessionUsageProgress, writeOutboundDirect } from './session-manager.js';
import { sessionLinkSocketPath, startSessionSignalServer, stopSessionSignalServer } from './session-link.js';

const TEST_DIR = '/tmp/nanoclaw-test-write-outbound';
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

async function sendSignal(frame: unknown): Promise<void> {
  await startSessionSignalServer(SESS);
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(sessionLinkSocketPath(SESS));
    socket.once('error', reject);
    socket.once('connect', () => socket.end(`${JSON.stringify(frame)}\n`));
    socket.once('close', () => resolve());
  });
}

describe('writeOutboundDirect', () => {
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

describe('readSessionUsageProgress', () => {
  it('returns a fresh valid snapshot received over the session link', async () => {
    const usage = {
      cost_usd: 0.25,
      input_tokens: 1200,
      output_tokens: 30,
      cache_read_tokens: 1000,
      cache_write_tokens: 0,
      num_turns: 2,
      model: 'minimax/MiniMax-M3',
      context_tokens: 1230,
      context_window: 1_048_576,
    };
    const before = Date.now();
    await sendSignal({ v: 2, type: 'usage', usage });
    expect(readSessionUsageProgress(AG, SESS)).toEqual(usage);
    expect(readSessionUsageProgress(AG, SESS, before)).toEqual(usage);
    expect(readSessionUsageProgress(AG, SESS, Date.now() + 1)).toBeNull();
  });
});
