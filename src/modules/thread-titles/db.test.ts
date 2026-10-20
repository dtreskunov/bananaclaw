import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA } from '../../db/schema.js';
import type { Session } from '../../types.js';
import { handleSetThreadTitle } from './actions.js';
import { normalizeThreadTitle, readThreadTitle, upsertThreadTitle } from './db.js';

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

  it('shows the first title immediately without any delivered reply', () => {
    expect(readThreadTitle(db, key)).toBeNull();
    expect(upsertThreadTitle(db, { ...key, title: 'OAuth token refresh failure', requestMessageId: 'in-1' })).toBe(
      true,
    );
    expect(readThreadTitle(db, key)).toBe('OAuth token refresh failure');
    expect(db.prepare('SELECT published FROM thread_titles').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM delivered').pluck().get()).toBe(0);
  });

  it('shows the latest title immediately without requiring a chat reply', () => {
    expect(upsertThreadTitle(db, { ...key, title: 'Original title', requestMessageId: 'in-1' })).toBe(true);
    expect(upsertThreadTitle(db, { ...key, title: 'Replacement title', requestMessageId: 'in-2' })).toBe(true);
    expect(readThreadTitle(db, key)).toBe('Replacement title');
    expect(db.prepare('SELECT request_message_id FROM thread_titles').pluck().get()).toBe('in-2');
    expect(db.prepare('SELECT COUNT(*) FROM delivered').pluck().get()).toBe(0);
  });

  it('shows legacy unpublished titles and marks subsequent updates as published', () => {
    upsertThreadTitle(db, { ...key, title: 'Greeting', requestMessageId: 'in-1' });
    db.prepare('UPDATE thread_titles SET published = 0').run();
    expect(readThreadTitle(db, key)).toBe('Greeting');

    expect(upsertThreadTitle(db, { ...key, title: 'Wedding photos transfer', requestMessageId: 'in-2' })).toBe(true);
    expect(readThreadTitle(db, key)).toBe('Wedding photos transfer');
    expect(db.prepare('SELECT request_message_id, published FROM thread_titles').get()).toEqual({
      request_message_id: 'in-2',
      published: 1,
    });

    expect(upsertThreadTitle(db, { ...key, title: '   ', requestMessageId: 'in-3' })).toBe(false);
    expect(readThreadTitle(db, key)).toBe('Wedding photos transfer');
  });

  it('only applies title updates whose request matches the session and inbound routing', async () => {
    const session: Session = {
      id: 'session-1',
      agent_group_id: 'group-1',
      messaging_group_id: 'messaging-group-1',
      thread_id: key.threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: '2026-10-20T00:00:00.000Z',
    };
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, platform_id, thread_id, content)
       VALUES ('in-2', 2, 'chat', datetime('now'), @channelType, @platformId, @threadId, '{"text":"Update thread title"}')`,
    ).run(key);
    upsertThreadTitle(db, { ...key, title: 'Greeting', requestMessageId: 'in-1' });
    const action = { ...key, title: 'Wedding photos transfer', requestMessageId: 'in-2' };

    for (const mismatch of [
      { channelType: 'telegram' },
      { platformId: 'other-user' },
      { threadId: 'other-thread' },
      { requestMessageId: 'missing-message' },
    ]) {
      await handleSetThreadTitle({ ...action, ...mismatch }, session, db);
      expect(readThreadTitle(db, key)).toBe('Greeting');
    }
    await handleSetThreadTitle(action, { ...session, thread_id: 'other-thread' }, db);
    expect(readThreadTitle(db, key)).toBe('Greeting');

    await handleSetThreadTitle(action, session, db);
    expect(readThreadTitle(db, key)).toBe('Wedding photos transfer');
  });

  it('keeps titles isolated by channel, platform and thread', () => {
    upsertThreadTitle(db, { ...key, title: 'Original title', requestMessageId: 'in-1' });
    for (const otherKey of [
      { ...key, channelType: 'telegram' },
      { ...key, platformId: 'other-user' },
      { ...key, threadId: 'other-thread' },
    ]) {
      expect(readThreadTitle(db, otherKey)).toBeNull();
      expect(upsertThreadTitle(db, { ...otherKey, title: 'Other title', requestMessageId: 'in-2' })).toBe(true);
      expect(readThreadTitle(db, otherKey)).toBe('Other title');
      expect(readThreadTitle(db, key)).toBe('Original title');
    }
  });
});
