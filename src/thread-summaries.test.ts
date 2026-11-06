import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve('.test-thread-summary-projection');
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof import('./config.js')>()),
  DATA_DIR: path.resolve('.test-thread-summary-projection'),
}));
import { initDb, closeDb, getDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import {
  initSessionFolder,
  inboundDbPath,
  outboundDbPath,
  seedRunnerState,
  runnerStateDbPath,
} from './session-manager.js';
import { upsertThreadTitle } from './modules/thread-titles/db.js';
import {
  assertThreadSummariesReady,
  readSessionThreadSummary,
  readSummaryQueuedRoutes,
  readSummaryTurns,
  reconcileThreadSummaries,
  rebuildThreadSummaries,
  refreshThreadSummaries,
  type ThreadSummarySpec,
} from './thread-summaries.js';
import { scanThreadSession } from './thread-summaries.fixture.js';

const spec: ThreadSummarySpec = {
  agentGroupId: 'g',
  sessionId: 's',
  thread: { channelType: 'web', platformId: 'group:g', threadId: 't' },
};
let inbound: Database.Database;
let outbound: Database.Database;
function message(id: string, platform = 'group:g', thread: string | null = 't', channel = 'web', text = 'Hello') {
  inbound
    .prepare(
      `INSERT INTO messages_in(id,seq,kind,timestamp,channel_type,platform_id,thread_id,content)
    VALUES (?,(SELECT COALESCE(MAX(seq),0)+2 FROM messages_in),'chat',1793836800000,?,?,?,?)`,
    )
    .run(id, channel, platform, thread, JSON.stringify({ text }));
}
beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  runMigrations(initDb(path.join(ROOT, 'v2.db')));
  getDb().exec(`INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','g',1793836800000);
    INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g',1793836800000);`);
  initSessionFolder('g', 's');
  inbound = new Database(inboundDbPath('g', 's'));
  outbound = new Database(outboundDbPath('g', 's'));
});
afterEach(async () => {
  await Promise.resolve();
  inbound.close();
  outbound.close();
  closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('maintained thread summaries', () => {
  it('keeps epoch-zero cache facts numeric and requires explicit rebuild for older string projections', () => {
    message('one');
    inbound.exec("UPDATE messages_in SET timestamp=0 WHERE id='one'");
    outbound.exec(`INSERT INTO turns(id,phase,outcome,provenance,started_at,
      origin_channel_type,origin_platform_id,origin_thread_id)
      VALUES('zero','running','pending','native',0,'web','group:g','t')`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec).threads[0].lastActivityAt).toBe(0);
    expect(readSummaryTurns('s')[0].started_at).toBe(0);
    getDb().exec(`UPDATE thread_summaries SET value=json_set(value,'$.last','1970-01-01T00:00:00Z')
      WHERE source='inbound' AND kind='route'`);
    expect(() => reconcileThreadSummaries()).toThrow('Numeric thread summaries require offline backfill');
    expect(() => readSessionThreadSummary(spec)).toThrow('Numeric thread summaries require offline backfill');
    rebuildThreadSummaries(ROOT);
    expect(readSessionThreadSummary(spec).threads[0].lastActivityAt).toBe(0);
    expect(inbound.prepare("SELECT timestamp FROM messages_in WHERE id='one'").get()).toEqual({ timestamp: 0 });
  });

  it('requires explicit backfill for old queue facts and refreshes the trigger gate capture', () => {
    message('one');
    refreshThreadSummaries('s');
    expect(readSummaryQueuedRoutes('s')).toHaveLength(1);
    getDb().exec("UPDATE thread_summaries SET value=json_remove(value,'$.pendingAt') WHERE source='inbound' AND kind='route'");
    expect(() => readSessionThreadSummary(spec)).toThrow('offline backfill');
    expect(() => readSummaryQueuedRoutes('s')).toThrow('offline backfill');
    inbound.exec("DROP TRIGGER thread_summary_messages_in_update");
    rebuildThreadSummaries(ROOT);
    expect(readSummaryQueuedRoutes('s')).toHaveLength(1);
    inbound.exec("UPDATE messages_in SET trigger=0 WHERE id='one'");
    refreshThreadSummaries('s');
    expect(readSummaryQueuedRoutes('s')).toHaveLength(0);
  });

  it('evaluates a future input becoming runnable without rebuilding its summary', () => {
    message('one');
    inbound.exec(`UPDATE messages_in SET process_after=${Date.parse('2999-01-01T00:00:00Z')}`);
    refreshThreadSummaries('s');
    expect(readSummaryQueuedRoutes('s')).toHaveLength(0);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2999-01-01T00:00:01Z'));
    expect(readSummaryQueuedRoutes('s')).toHaveLength(1);
  });
  it('does not copy host projection tracking into the container-owned runner store', () => {
    seedRunnerState('g', 's', true);
    const runner = new Database(runnerStateDbPath('g', 's'), { readonly: true });
    try {
      expect(runner.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'thread_summary_%'`).all()).toEqual([]);
    } finally {
      runner.close();
    }
  });
  it('matches the historical reader for per-thread counts, titles, owners, usage and tasks', () => {
    message('one');
    message('two');
    outbound.exec(`INSERT INTO messages_out(id,seq,kind,timestamp,channel_type,platform_id,thread_id,content)
      VALUES('reply',1,'chat',1793836860000,'web','group:g','t','{"text":"Done"}');
      INSERT INTO turn_usage(id,cost_usd,input_tokens,output_tokens) VALUES('usage',0.5,100,20);`);
    upsertThreadTitle(inbound, { ...spec.thread!, title: 'Published title', requestMessageId: 'one' });
    inbound.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,series_id,process_after,content)
      VALUES('task',6,'task',1793836800000,'pending','web','group:g','t','series',1793923200000,'{"prompt":"Do the scheduled thing"}');`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
    expect(inbound.prepare('SELECT COUNT(*) FROM thread_summary_dirty').pluck().get()).toBe(0);
    expect(outbound.prepare('SELECT COUNT(*) FROM thread_summary_dirty').pluck().get()).toBe(0);
  });
  it.each(['fallback', 'explicit', 'email'])('preserves complete %s titles from existing projection facts', (source) => {
    const title = 'Detailed household expense categorization and reconciliation across multiple credit accounts';
    const channel = source === 'email' ? 'resend' : 'web';
    const titledSpec = { ...spec, thread: { ...spec.thread!, channelType: channel } };
    message('one', 'group:g', 't', channel, `> Context from earlier\n\n  ${title}  `);
    if (source === 'explicit') {
      upsertThreadTitle(inbound, { ...titledSpec.thread, title, requestMessageId: 'one' });
    } else if (source === 'email') {
      inbound.prepare('UPDATE messages_in SET content=? WHERE id=?')
        .run(JSON.stringify({ subject: title, text: 'Different email body' }), 'one');
    }
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(titledSpec).threads[0].title).toBe(title);
    expect(readSessionThreadSummary(titledSpec)).toEqual(scanThreadSession(ROOT, titledSpec));
  });
  it('preserves independent shared routing scopes and DM totals', () => {
    message('one', 'a@example.com', 'mail', 'resend', 'A');
    message('two', 'b@example.com', 'mail', 'resend', 'B');
    message('dm', 'telegram:123', null, 'telegram');
    refreshThreadSummaries('s');
    const shared = { ...spec, thread: undefined };
    expect(readSessionThreadSummary(shared)).toEqual(scanThreadSession(ROOT, shared));
  });
  it('does not invent DM reply groups for non-chat output or deleted replies', () => {
    message('one');
    outbound.exec(`INSERT INTO messages_out(id,seq,kind,timestamp,content)
      VALUES('internal',1,'state',1793836800000,'{}');`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
    expect(readSessionThreadSummary(spec).dmReplies).toEqual([]);
    outbound.exec(`INSERT INTO messages_out(id,seq,kind,timestamp,channel_type,platform_id,content)
      VALUES('dm-reply',3,'chat',1793836860000,'telegram','person','{"text":"Reply"}');`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec).dmReplies).toHaveLength(1);
    outbound.exec(`DELETE FROM messages_out WHERE id='dm-reply'`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
    expect(readSessionThreadSummary(spec).dmReplies).toEqual([]);
  });
  it.each(['plain unparsed text', '"A JSON string"', '{"cancelled":true,"text":"Hidden"}', '{"text":"Visible"}'])(
    'preserves historical fallback-title semantics for %s',
    (content) => {
      message('one');
      inbound.prepare('UPDATE messages_in SET content=? WHERE id=?').run(content, 'one');
      refreshThreadSummaries('s');
      expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
    },
  );
  it.each(['"JSON task prompt"', '{"text":"Not a task prompt"}'])(
    'preserves historical task-summary semantics for %s',
    (content) => {
      message('one');
      inbound
        .prepare(
          `INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,series_id,content)
        VALUES('task',4,'task',1793836800000,'pending','web','group:g','t','series',?)`,
        )
        .run(content);
      refreshThreadSummaries('s');
      expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
    },
  );
  it('surfaces malformed task data and retains its dirty route for repair', () => {
    message('one');
    inbound.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,series_id,content)
      VALUES('task',4,'task',1793836800000,'pending','web','group:g','t','series','not JSON');`);
    expect(() => refreshThreadSummaries('s')).toThrow(/JSON/);
    expect(() => readSessionThreadSummary(spec)).toThrow('projection unavailable');
    inbound.prepare('UPDATE messages_in SET content=? WHERE id=?').run('{"prompt":"Repaired"}', 'task');
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
  });
  it('uses only the central projection for reads even while both sources are locked', () => {
    message('one');
    refreshThreadSummaries('s');
    const expected = readSessionThreadSummary(spec);
    inbound.exec('BEGIN EXCLUSIVE');
    outbound.exec('BEGIN EXCLUSIVE');
    try {
      expect(readSessionThreadSummary(spec)).toEqual(expected);
    } finally {
      inbound.exec('ROLLBACK');
      outbound.exec('ROLLBACK');
    }
  });
  it('uses a route index and recomputes only the committed dirty route', () => {
    inbound.transaction(() => {
      for (let index = 0; index < 1000; index++) message(`message-${index}`);
      message('other', 'group:g', 'other');
    })();
    refreshThreadSummaries('s');
    message('new-message');
    expect(inbound.prepare('SELECT kind,thread_id FROM thread_summary_dirty').all()).toEqual([
      { kind: 'route', thread_id: 't' },
    ]);
    const plan = inbound
      .prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*),MAX(timestamp) FROM messages_in
      WHERE channel_type=? AND COALESCE(platform_id,'')=? AND COALESCE(thread_id,'')=?`,
      )
      .all('web', 'group:g', 't') as { detail: string }[];
    expect(plan.some((row) => row.detail.includes('idx_messages_in_summary'))).toBe(true);
    const started = performance.now();
    refreshThreadSummaries('s');
    expect(performance.now() - started).toBeLessThan(250);
    expect(readSessionThreadSummary(spec).threads[0].messageCount).toBe(1001);
  });
  it('keeps the latest task occurrence across platform contributions in a per-thread session', () => {
    message('one');
    inbound.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,series_id,process_after,content)
      VALUES('task-old',4,'task',1793836800000,'pending','web','group:g','t','series',1793923200000,'{"prompt":"Old"}'),
        ('task-new',6,'task',1793836800000,'paused','web','alternate','t','series',NULL,'{"prompt":"Latest"}');`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
    expect(readSessionThreadSummary(spec).threads[0].liveTasks).toEqual([
      { seriesId: 'series', nextRunAt: null, recurrence: null, summary: 'Latest', paused: true },
    ]);
  });
  it('coalesces routes transactionally and publishes no rolled-back changes', () => {
    expect(() =>
      inbound.transaction(() => {
        message('rollback');
        throw new Error('rollback');
      })(),
    ).toThrow('rollback');
    expect(inbound.prepare('SELECT COUNT(*) FROM thread_summary_dirty').pluck().get()).toBe(0);
    message('one');
    message('two');
    expect(inbound.prepare('SELECT COUNT(*) FROM thread_summary_dirty').pluck().get()).toBe(1);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec).threads[0].messageCount).toBe(2);
    message('three');
    expect(inbound.prepare('SELECT revision FROM thread_summary_dirty').pluck().get()).toBeGreaterThan(2);
  });
  it('recovers committed but unpublished changes on startup without reading history in a subscriber', () => {
    message('one');
    refreshThreadSummaries('s');
    message('missed-notice');
    expect(readSessionThreadSummary(spec).threads[0].messageCount).toBe(1);
    closeDb();
    initDb(path.join(ROOT, 'v2.db'));
    reconcileThreadSummaries();
    expect(readSessionThreadSummary(spec).threads[0].messageCount).toBe(2);
  });
  it.each(['central-copy', 'source-ack'])('recovers idempotently after failure at %s', (failure) => {
    message('one');
    const target = failure === 'central-copy' ? getDb() : inbound;
    target.exec(
      failure === 'central-copy'
        ? `CREATE TRIGGER fail_projection BEFORE INSERT ON thread_summaries BEGIN SELECT RAISE(ABORT,'copy failure'); END;`
        : `CREATE TRIGGER fail_projection BEFORE DELETE ON thread_summary_dirty BEGIN SELECT RAISE(ABORT,'ack failure'); END;`,
    );
    expect(() => refreshThreadSummaries('s')).toThrow('failure');
    expect(inbound.prepare('SELECT COUNT(*) FROM thread_summary_dirty').pluck().get()).toBe(1);
    expect(() => readSessionThreadSummary(spec)).toThrow('projection unavailable');
    target.exec('DROP TRIGGER fail_projection');
    refreshThreadSummaries('s');
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec).threads[0].messageCount).toBe(1);
  });
  it('blocks stale reads even when the central database cannot write an error record', () => {
    message('one');
    refreshThreadSummaries('s');
    message('committed');
    getDb().pragma('query_only = ON');
    try {
      expect(() => refreshThreadSummaries('s')).toThrow(/readonly/);
      expect(() => readSessionThreadSummary(spec)).toThrow('projection unavailable');
      expect(inbound.prepare('SELECT COUNT(*) FROM thread_summary_dirty').pluck().get()).toBe(1);
    } finally {
      getDb().pragma('query_only = OFF');
    }
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec).threads[0].messageCount).toBe(2);
  });
  it('updates titles, route moves, deletions and usage replacements without double counting', () => {
    message('one');
    outbound.exec(`INSERT INTO turn_usage(id,cost_usd,input_tokens,output_tokens) VALUES('usage',1,10,5);`);
    refreshThreadSummaries('s');
    inbound.prepare('UPDATE messages_in SET content=? WHERE id=?').run('{"text":"Edited"}', 'one');
    outbound.exec(`UPDATE turn_usage SET cost_usd=2,input_tokens=20 WHERE id='usage'`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary(spec)).toMatchObject({
      threads: [{ title: 'Edited', messageCount: 1 }],
      totalCost: 2,
      totalTokens: 25,
      turnCount: 1,
    });
    inbound.exec(`UPDATE messages_in SET thread_id='other' WHERE id='one'`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary({ ...spec, thread: undefined }).threads.map((thread) => thread.threadId)).toEqual([
      'other',
    ]);
    inbound.exec(`DELETE FROM messages_in WHERE id='one'`);
    refreshThreadSummaries('s');
    expect(readSessionThreadSummary({ ...spec, thread: undefined }).threads).toEqual([]);
  });
  it('requires explicit backfill, and rebuilds all existing routes without reviving deleted data', () => {
    message('one');
    getDb().exec('UPDATE thread_summary_meta SET ready=0');
    expect(() => assertThreadSummariesReady()).toThrow('offline backfill');
    rebuildThreadSummaries();
    expect(readSessionThreadSummary(spec)).toEqual(scanThreadSession(ROOT, spec));
    inbound.exec(`DELETE FROM messages_in WHERE id='one'`);
    rebuildThreadSummaries();
    expect(readSessionThreadSummary({ ...spec, thread: undefined }).threads).toEqual([]);
  });
  it('removes derived rows together with their central session', () => {
    message('one');
    refreshThreadSummaries('s');
    getDb().prepare('DELETE FROM sessions WHERE id=?').run('s');
    expect(getDb().prepare('SELECT COUNT(*) FROM thread_summaries').pluck().get()).toBe(0);
  });
});
