import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-host-event-journal-test',
}));

import { replaceDestinations, retryWithBackoff, upsertSessionRouting } from './db/session-db.js';
import { inboundDbPath, initSessionFolder } from './session-manager.js';
import { writeSessionMessage } from './session-manager.js';
import { stageThreadTitle } from './modules/thread-titles/db.js';

const ROOT = '/tmp/nanoclaw-host-event-journal-test';
const AGENT_GROUP_ID = 'agent-a';
const SESSION_ID = 'session-a';

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  initSessionFolder(AGENT_GROUP_ID, SESSION_ID);
});

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('host event journal', () => {
  it('journals sequence and complete message snapshots for inserts and updates', () => {
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    try {
      db.prepare(
        `UPDATE host_sequence SET last_even = 2 WHERE id = 1`,
      ).run();
      db.prepare(
        `INSERT INTO messages_in
          (id, seq, kind, timestamp, status, process_after, recurrence, series_id,
           tries, trigger, platform_id, channel_type, thread_id, content,
           source_session_id, on_wake, sender_user_id, sender_identity)
         VALUES ('in-1', 2, 'chat', '2026-09-01 00:00:00', 'pending', NULL, NULL,
           'in-1', 0, 1, 'chat-1', 'web', NULL, '{"text":"hello"}', NULL, 0, NULL, 'web:user-1')`,
      ).run();
      retryWithBackoff(db, 'in-1', 5);

      const events = db
        .prepare('SELECT sequence, event_type, payload FROM pending_host_events ORDER BY sequence')
        .all() as Array<{ sequence: number; event_type: string; payload: string }>;
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(events.map((event) => event.event_type)).toEqual([
        'sequence.floor',
        'message.upsert',
        'message.upsert',
      ]);
      expect(JSON.parse(events[2].payload)).toMatchObject({
        id: 'in-1',
        tries: 1,
        content_hex: Buffer.from('{"text":"hello"}').toString('hex').toUpperCase(),
      });
    } finally {
      db.close();
    }
  });

  it('journals atomic routing and destination snapshots', () => {
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    try {
      upsertSessionRouting(db, { channel_type: 'web', platform_id: 'chat-1', thread_id: 'thread-1' });
      replaceDestinations(db, [
        {
          name: 'current',
          display_name: 'Current chat',
          type: 'channel',
          channel_type: 'web',
          platform_id: 'chat-1',
          agent_group_id: null,
        },
      ]);
      const events = db
        .prepare('SELECT event_type, payload FROM pending_host_events ORDER BY sequence')
        .all() as Array<{ event_type: string; payload: string }>;
      expect(events.map((event) => event.event_type)).toEqual(['routing.upsert', 'destinations.replace']);
      expect(JSON.parse(events[1].payload)).toMatchObject({ entries: [{ name: 'current' }] });
    } finally {
      db.close();
    }
  });

  it('journals thread title changes', () => {
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    try {
      expect(
        stageThreadTitle(db, {
          channelType: 'web',
          platformId: 'chat-1',
          threadId: 'thread-1',
          title: 'Host event projection',
          requestMessageId: 'in-1',
        }),
      ).toBe(true);
      const event = db.prepare('SELECT event_type, payload FROM pending_host_events').get() as {
        event_type: string;
        payload: string;
      };
      expect(event.event_type).toBe('thread-title.upsert');
      expect(JSON.parse(event.payload)).toMatchObject({ title: 'Host event projection', published: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects oversized inbound content before journaling', () => {
    expect(() =>
      writeSessionMessage(AGENT_GROUP_ID, SESSION_ID, {
        id: 'too-large',
        kind: 'chat',
        timestamp: '2026-09-01 00:00:00',
        content: 'x'.repeat(10 * 1024 * 1024 + 1),
      }),
    ).toThrow('exceeds the 10485760-byte session-link limit');

    const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) FROM messages_in').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM pending_host_events').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects oversized content from direct session DB writers', () => {
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    try {
      expect(() =>
        db.prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, content)
           VALUES ('direct-too-large', 2, 'task', datetime('now'), ?)`,
        ).run('x'.repeat(10 * 1024 * 1024 + 1)),
      ).toThrow('inbound message exceeds session-link limit');
      expect(db.prepare('SELECT COUNT(*) FROM pending_host_events').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects host event fields and destination snapshots outside runner limits', () => {
    const db = new Database(inboundDbPath(AGENT_GROUP_ID, SESSION_ID));
    try {
      expect(() =>
        replaceDestinations(
          db,
          Array.from({ length: 513 }, (_, index) => ({
            name: `destination-${index}`,
            display_name: null,
            type: 'channel' as const,
            channel_type: 'web',
            platform_id: `chat-${index}`,
            agent_group_id: null,
          })),
        ),
      ).toThrow('destination snapshot exceeds session-link limit');
      expect(() =>
        writeSessionMessage(AGENT_GROUP_ID, SESSION_ID, {
          id: 'x'.repeat(257),
          kind: 'chat',
          timestamp: '2026-09-01 00:00:00',
          content: '{"text":"hello"}',
        }),
      ).toThrow('insertMessage.id exceeds session-link limit');
      expect(() =>
        db.prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, recurrence, content)
           VALUES ('direct-bad-envelope', 2, 'task', datetime('now'), ?, '{}')`,
        ).run('x'.repeat(1025)),
      ).toThrow('inbound message envelope exceeds session-link limit');
      expect(db.prepare('SELECT COUNT(*) FROM pending_host_events').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });
});
