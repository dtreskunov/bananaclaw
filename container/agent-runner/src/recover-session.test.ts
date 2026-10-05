import { afterEach, beforeEach, expect, it } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { listPendingRunnerEvents } from './db/runner-state.js';
import { recoverSession } from './recover-session.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

it('drains a recorded failure before checking for abandoned turns, without invoking a provider', async () => {
  const db = getOutboundDb();
  db.prepare(
    "INSERT INTO turns (id,phase,outcome,provenance,ended_at) VALUES ('failed-turn','settled','failed','native','2026-10-04T20:33:00.401Z')",
  ).run();
  let drains = 0;
  await recoverSession(async () => {
    drains++;
    expect(db.prepare('SELECT phase,outcome FROM turns').get()).toEqual({ phase: 'settled', outcome: 'failed' });
    db.exec('DELETE FROM pending_runner_events');
  });
  expect(drains).toBe(2);
  expect(listPendingRunnerEvents(db, 1)).toEqual([]);
});

it('settles truly abandoned turns and their compaction activity as interrupted only after replay', async () => {
  const db = getOutboundDb();
  db.prepare(
    "INSERT INTO turns (id,phase,outcome,provenance,started_at) VALUES ('abandoned','running','pending','native','2026-10-04T20:22:46.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO turn_activity (turn_id,ordinal,ts,text,timeline_position) VALUES ('abandoned',0,'123',?,123)",
  ).run(JSON.stringify({ kind: 'compaction', id: 'compact-1', status: 'running' }));
  let drains = 0;
  await recoverSession(async () => {
    drains++;
    expect(db.prepare('SELECT phase,outcome FROM turns').get()).toEqual(
      drains === 1 ? { phase: 'running', outcome: 'pending' } : { phase: 'settled', outcome: 'interrupted' },
    );
    db.exec('DELETE FROM pending_runner_events');
  });
  expect(
    JSON.parse(
      (db.prepare('SELECT text FROM turn_activity ORDER BY ordinal DESC LIMIT 1').get() as { text: string }).text,
    ),
  ).toMatchObject({ kind: 'compaction', status: 'interrupted' });
  expect(db.prepare('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
});
