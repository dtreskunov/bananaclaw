import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../../db/schema.js';
import { scanThreadSession, type ThreadScanSpec } from './thread-scan.js';
import { ThreadScanner } from './thread-scanner.js';

let dataDir: string;
let scanner: ThreadScanner;
const databases: Database.Database[] = [];
const spec: ThreadScanSpec = {
  agentGroupId: 'group',
  sessionId: 'session',
  thread: { channelType: 'web', platformId: 'group:group', threadId: 'thread' },
};
const now = '2026-10-17T06:00:00.000Z';

function session(input = spec): { inbound: Database.Database; outbound: Database.Database } {
  const directory = path.join(dataDir, 'v2-sessions', input.agentGroupId, input.sessionId);
  fs.mkdirSync(directory, { recursive: true });
  const inbound = new Database(path.join(directory, 'inbound.db'));
  const outbound = new Database(path.join(directory, 'outbound.db'));
  databases.push(inbound, outbound);
  inbound.exec(INBOUND_SCHEMA);
  outbound.exec(OUTBOUND_SCHEMA);
  return { inbound, outbound };
}

function message(
  db: Database.Database,
  id: string,
  channel = 'web',
  platform = 'group:group',
  thread: string | null = 'thread',
  content = '{"text":"Hello"}',
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, platform_id, thread_id, content)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat', ?, ?, ?, ?, ?)`,
  ).run(id, now, channel, platform, thread, content);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-thread-scanner-'));
  scanner = new ThreadScanner(dataDir);
});

afterEach(async () => {
  await scanner.close();
  for (const db of databases.splice(0)) db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('thread scanner', () => {
  it('runs the same read-only session scan in a persistent worker and coalesces requests', async () => {
    const { inbound, outbound } = session();
    message(inbound, 'one');
    outbound
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, platform_id, thread_id, content)
       VALUES ('answer', 1, ?, 'chat', 'web', 'group:group', 'thread', '{"text":"Done"}')`,
      )
      .run(now);
    outbound
      .prepare(`INSERT INTO turn_usage (id, cost_usd, input_tokens, output_tokens) VALUES ('usage', 0.5, 100, 20)`)
      .run();
    const request = scanner.scan([spec]);
    expect(scanner.scan([spec])).toBe(request);
    const [actual] = await request;
    expect(actual).toEqual(scanThreadSession(dataDir, spec));
    expect(actual.threads).toEqual([
      {
        ...spec.thread,
        title: 'Hello',
        messageCount: 2,
        lastActivityAt: now,
      },
    ]);
    expect(actual).toMatchObject({ owners: ['group:group'], totalCost: 0.5, totalTokens: 120, turnCount: 1 });
    expect(await scanner.scan([spec])).toEqual([actual]);
  });

  it('keeps host timers responsive while SQLite in the worker is blocked', async () => {
    const { inbound } = session();
    message(inbound, 'one');
    await scanner.scan([spec]);
    scanner.invalidate(spec.sessionId);
    inbound.exec('BEGIN EXCLUSIVE');
    try {
      const started = performance.now();
      const request = scanner.scan([spec]);
      const rejected = expect(request).rejects.toThrow(/locked/);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(performance.now() - started).toBeLessThan(150);
      await rejected;
    } finally {
      inbound.exec('ROLLBACK');
    }
  });

  it('rejects unreadable session databases without creating empty databases', async () => {
    await expect(scanner.scan([spec])).rejects.toThrow(/open database/);
    expect(fs.existsSync(path.join(dataDir, 'v2-sessions', 'group', 'session'))).toBe(false);
  });

  it('settles pending requests on shutdown and can start a fresh worker', async () => {
    session();
    const request = scanner.scan([spec]);
    const rejected = expect(request).rejects.toThrow('stopped');
    await scanner.close();
    await rejected;
    expect(await scanner.scan([spec])).toHaveLength(1);
  });

  it('bounds distinct pending requests rather than accumulating an unbounded worker queue', async () => {
    const requests = Array.from({ length: 32 }, (_, index) =>
      scanner.scan([{ ...spec, sessionId: `pending-${index}` }]),
    );
    const settled = Promise.allSettled(requests);
    await expect(scanner.scan([spec])).rejects.toThrow('busy');
    await scanner.close();
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  });

  it('does not join an older in-flight scan after invalidation or let its completion clear a newer request', async () => {
    const { inbound } = session();
    message(inbound, 'one');
    const older = scanner.scan([spec]);
    scanner.invalidate(spec.sessionId);
    const newer = scanner.scan([spec]);
    expect(newer).not.toBe(older);
    expect(scanner.scan([spec])).toBe(newer);
    await older;
    await newer;
    message(inbound, 'two');
    scanner.invalidate(spec.sessionId);
    expect((await scanner.scan([spec]))[0].threads[0].messageCount).toBe(2);
  });

  it('does not lose a dirty session when a different session is scanned first', async () => {
    const { inbound } = session();
    const other = { ...spec, sessionId: 'other' };
    session(other);
    message(inbound, 'one');
    await scanner.scan([spec]);
    message(inbound, 'two');
    scanner.invalidate(spec.sessionId);
    await scanner.scan([other]);
    expect((await scanner.scan([spec]))[0].threads[0].messageCount).toBe(2);
  });

  it('groups shared threads and DMs without mixing routing scopes', async () => {
    const shared = { ...spec, thread: undefined };
    const { inbound } = session(shared);
    message(inbound, 'email-a', 'resend', 'a@example.com', 'email-thread', '{"subject":"A subject"}');
    message(inbound, 'email-b', 'resend', 'b@example.com', 'email-thread', '{"subject":"B subject"}');
    message(inbound, 'dm', 'telegram', 'telegram:123', null);
    const [scan] = await scanner.scan([shared]);
    expect(scan.threads.map((thread) => [thread.platformId, thread.title])).toEqual([
      ['a@example.com', 'A subject'],
      ['b@example.com', 'B subject'],
    ]);
    expect(scan.dms).toEqual([
      {
        channelType: 'telegram',
        platformId: 'telegram:123',
        messageCount: 1,
        lastActivityAt: now,
      },
    ]);
  });

  it('preserves title publication, ownership checks, task summaries and cancelled input semantics', async () => {
    const { inbound } = session();
    message(inbound, 'one', 'web', 'group:group', 'thread', '{"text":"Hidden","cancelled":true,"sender":"owner"}');
    inbound
      .prepare(
        `INSERT INTO thread_titles
       (channel_type, platform_id, thread_id, title, source, request_message_id, published, updated_at)
       VALUES ('web', 'group:group', 'thread', 'Published', 'model', 'one', 0, ?)`,
      )
      .run(now);
    expect((await scanner.scan([spec]))[0].threads[0].title).toBe('(new thread)');
    inbound.prepare('UPDATE thread_titles SET published = 1').run();
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, thread_id, content,
        series_id, recurrence, process_after)
       VALUES ('task', 4, 'task', ?, 'web', 'thread', '{"prompt":"Do work\\nDetails"}',
         'series', '0 9 * * *', ?)`,
      )
      .run(now, now);
    scanner.invalidate(spec.sessionId);
    const [scan] = await scanner.scan([spec]);
    expect(scan.threads[0]).toMatchObject({
      title: 'Published',
      liveTasks: [
        {
          seriesId: 'series',
          nextRunAt: now,
          recurrence: '0 9 * * *',
          summary: 'Do work',
          paused: false,
        },
      ],
    });
    expect(scan.owners).toContain('owner');
  });
});
