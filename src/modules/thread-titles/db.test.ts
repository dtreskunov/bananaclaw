import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA } from '../../db/schema.js';
import {
  normalizeThreadTitle,
  publishThreadTitle,
  publishTitlesForDeliveredReplies,
  readPublishedThreadTitle,
  stageThreadTitle,
} from './db.js';

describe('thread title metadata', () => {
  let db: Database.Database;
  const key = { channelType: 'web', platformId: 'user-1', threadId: 'thread-1' };

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
  });

  afterEach(() => db.close());

  it('normalizes and bounds model titles', () => {
    expect(normalizeThreadTitle('  OAuth\n token   refresh failure  ')).toBe('OAuth token refresh failure');
    expect(normalizeThreadTitle('x'.repeat(80))).toBe('x'.repeat(60));
    expect(normalizeThreadTitle('(new thread)')).toBeNull();
  });

  it('keeps staged titles hidden until the matching reply is published', () => {
    expect(stageThreadTitle(db, { ...key, title: 'OAuth token refresh failure', requestMessageId: 'in-1' })).toBe(true);
    expect(readPublishedThreadTitle(db, key)).toBeNull();
    expect(publishThreadTitle(db, key, 'wrong-message')).toBe(false);
    expect(publishThreadTitle(db, key, 'in-1')).toBe(true);
    expect(readPublishedThreadTitle(db, key)).toBe('OAuth token refresh failure');
  });

  it('does not let repeated model actions rename a thread', () => {
    expect(stageThreadTitle(db, { ...key, title: 'Original title', requestMessageId: 'in-1' })).toBe(true);
    expect(stageThreadTitle(db, { ...key, title: 'Replacement title', requestMessageId: 'in-2' })).toBe(false);
    expect(publishThreadTitle(db, key, 'in-1')).toBe(true);
    expect(readPublishedThreadTitle(db, key)).toBe('Original title');
  });

  it('publishes after the matching visible reply is delivered', () => {
    const outDb = new Database(':memory:');
    outDb.exec(`
      CREATE TABLE messages_out (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        in_reply_to TEXT,
        kind TEXT,
        platform_id TEXT,
        channel_type TEXT,
        thread_id TEXT
      )
    `);
    stageThreadTitle(db, { ...key, title: 'OAuth token refresh failure', requestMessageId: 'in-1' });
    outDb.prepare("INSERT INTO messages_out VALUES ('out-1', 1, NULL, 'chat', 'user-1', 'web', 'thread-1')").run();

    expect(publishTitlesForDeliveredReplies(db, outDb)).toBe(0);
    db.prepare(
      "INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES ('out-1', NULL, 'delivered', datetime('now'))",
    ).run();
    expect(publishTitlesForDeliveredReplies(db, outDb)).toBe(1);
    expect(readPublishedThreadTitle(db, key)).toBe('OAuth token refresh failure');
    expect(publishTitlesForDeliveredReplies(db, outDb)).toBe(0);
    outDb.close();
  });
});
