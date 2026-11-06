import { parseTimestamp } from './time.js';

/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import {
  IDLE_CEILING_MS,
  CLAIM_STUCK_MS,
  SESSION_LINK_START_GRACE_MS,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
} from './host-sweep.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: BASE - offsetMs };
}

describe('decideStuckAction', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Kolkata'])('uses exact epoch-zero claims regardless of host zone %s', (zone) => {
    vi.stubEnv('TZ', zone);
    try {
      expect(decideStuckAction({
        now: 60_123, lastSignalAtMs: 0, containerState: null,
        claims: [{ message_id: 'epoch-zero', status_changed: 0 }],
      })).toEqual({
        action: 'kill-claim', messageId: 'epoch-zero', claimAgeMs: 60_123, toleranceMs: 60_000,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns ok when the latest signal is fresh and there are no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        lastSignalAtMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-idle when the latest signal is older than 30 min', () => {
    const lastSignalAtMs = BASE - IDLE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-idle');
    if (res.action !== 'kill-idle') return;
    expect(res.idleMs).toBe(IDLE_CEILING_MS);
    expect(res.signalAgeMs).toBeGreaterThan(IDLE_CEILING_MS);
  });

  it('skips the ceiling check when a fresh container has not signaled yet', () => {
    // A freshly-spawned container hasn't produced any SDK events yet. Treating
    // the absent signal as infinitely stale would kill
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when signals are absent and a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never sent a live signal. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('gives an adopted session time to reconnect before evaluating an old claim', () => {
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: 0,
      sessionLinkStartedAtMs: BASE - SESSION_LINK_START_GRACE_MS + 1,
      containerState: null,
      claims: [claim('old-claim', CLAIM_STUCK_MS + 60_000)],
    });
    expect(res).toEqual({ action: 'ok' });
  });

  it('evaluates an old claim after the session-link startup grace expires', () => {
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: 0,
      sessionLinkStartedAtMs: BASE - SESSION_LINK_START_GRACE_MS,
      containerState: null,
      claims: [claim('old-claim', CLAIM_STUCK_MS + 60_000)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      lastSignalAtMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: BASE - 45 * 60 * 1000,
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it.each([IDLE_CEILING_MS + 1, 24 * 60 * 60 * 1000])(
    'keeps a %sms-old task alive while signals remain fresh',
    (age) => {
      const res = decideStuckAction({
        now: BASE,
        lastSignalAtMs: BASE - 1_000,
        containerState: null,
        claims: [claim('msg-1', age)],
      });
      expect(res).toEqual({ action: 'ok' });
    },
  );

  it('caps an untrusted declared Bash timeout', () => {
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: BASE - 7 * 60 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: Number.MAX_SAFE_INTEGER,
        tool_started_at: BASE - 7 * 60 * 60 * 1000,
      },
      claims: [claim('msg-1', 7 * 60 * 60 * 1000)],
    });
    expect(res).toEqual({ action: 'kill-idle', signalAgeMs: 7 * 60 * 60 * 1000, idleMs: 6 * 60 * 60 * 1000 });
  });

  it('returns kill-claim when a claim is past 60s and the signal timestamp has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when a signal arrived after the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it.each(['Bash', 'bash'])('honors the declared %s timeout at the claim-stuck boundary', (current_tool) => {
    const tenMinMs = 10 * 60 * 1000;
    for (const claimAgeMs of [5 * 60 * 1000, tenMinMs, tenMinMs + 1]) {
      const res = decideStuckAction({
        now: BASE,
        lastSignalAtMs: 0,
        containerState: {
          current_tool,
          tool_declared_timeout_ms: tenMinMs,
          tool_started_at: BASE - claimAgeMs,
        },
        claims: [claim('msg-1', claimAgeMs)],
      });
      expect(res.action).toBe(claimAgeMs <= tenMinMs ? 'ok' : 'kill-claim');
    }
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      lastSignalAtMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: Number.NaN }],
    });
    expect(res.action).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE host_sequence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_even INTEGER NOT NULL
    );
    INSERT INTO host_sequence VALUES (1, 0);
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     INTEGER NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after INTEGER,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed INTEGER NOT NULL
    );
  `);
  outDb.exec(`
    CREATE TABLE messages_out (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      in_reply_to   TEXT,
      timestamp     INTEGER NOT NULL,
      deliver_after TEXT,
      recurrence    TEXT,
      kind          TEXT NOT NULL,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: Date.now(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = Date.now();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(parseTimestamp(claimedAt));
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(parseTimestamp(claimedAt));

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(parseTimestamp(claimedAt), parseTimestamp(future));
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(parseTimestamp(claimedAt));

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });
});

describe('resetStuckProcessingRows — failure bounce', () => {
  function bounceRows(outDb: Database.Database) {
    return outDb
      .prepare('SELECT id, in_reply_to, kind, platform_id, channel_type, thread_id, content FROM messages_out')
      .all() as Array<{
      id: string;
      in_reply_to: string | null;
      kind: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
    }>;
  }

  it('bounces a user notice when a chat message is abandoned after max retries', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, platform_id, channel_type, thread_id, content) VALUES ('m-3', 2, 'chat', ?, 'pending', 5, 'chan-1', 'web', 'thread-1', '{\"text\":\"hi\"}')",
      )
      .run(parseTimestamp(claimedAt));
    inDb.prepare('UPDATE host_sequence SET last_even = 2 WHERE id = 1').run();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-3', 'processing', ?)").run(parseTimestamp(claimedAt));

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    const status = (inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get('m-3') as { status: string })
      .status;
    expect(status).toBe('failed');

    const rows = bounceRows(outDb);
    expect(rows).toHaveLength(1);
    expect(rows[0].in_reply_to).toBe('m-3');
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].platform_id).toBe('chan-1');
    expect(rows[0].channel_type).toBe('web');
    expect(rows[0].thread_id).toBe('thread-1');
    expect(JSON.parse(rows[0].content).text).toContain("couldn't be processed");
    expect(JSON.parse(rows[0].content).text).toContain('External actions may already have completed');

    // Orphan claim still cleared.
    expect(getProcessingClaims(outDb)).toEqual([]);
  });

  it('does not bounce for a non-chat (system) message', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, platform_id, channel_type, content) VALUES ('m-4', 2, 'system', ?, 'pending', 5, 'chan-1', 'web', '{}')",
      )
      .run(parseTimestamp(claimedAt));
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-4', 'processing', ?)").run(parseTimestamp(claimedAt));

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(bounceRows(outDb)).toHaveLength(0);
  });

  it('does not bounce when the message has no channel routing', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-5', 2, 'chat', ?, 'pending', 5, '{}')",
      )
      .run(parseTimestamp(claimedAt));
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-5', 'processing', ?)").run(parseTimestamp(claimedAt));

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(bounceRows(outDb)).toHaveLength(0);
  });

  it('does not bounce a message that is merely retried (below max)', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, platform_id, channel_type, content) VALUES ('m-6', 2, 'chat', ?, 'pending', 0, 'chan-1', 'web', '{}')",
      )
      .run(parseTimestamp(claimedAt));
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-6', 'processing', ?)").run(parseTimestamp(claimedAt));

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(bounceRows(outDb)).toHaveLength(0);
    const status = (inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get('m-6') as { status: string })
      .status;
    expect(status).toBe('pending');
  });
});
