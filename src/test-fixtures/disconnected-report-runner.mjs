import net from 'node:net';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../../container/agent-runner/src/db/connection.ts';
import { putTurn } from '../../container/agent-runner/src/db/turns.ts';
import { SessionSignalClient } from '../../container/agent-runner/src/session-link.ts';

const createConnection = net.createConnection;
let transport;
net.createConnection = function (...args) {
  transport = createConnection.apply(this, args);
  return transport;
};
initTestSessionDb({ unifiedHostProjection: true });
const db = getOutboundDb();
const client = new SessionSignalClient(process.argv[2]);
const turn = {
  id: 'saved-turn',
  origin_channel_type: 'web',
  origin_platform_id: 'chat',
  origin_thread_id: null,
  origin_source_session_id: null,
  started_at: '2026-10-04T20:22:46.226Z',
  ended_at: null,
  phase: 'running',
  outcome: 'pending',
  provenance: 'native',
  imported_from_session_id: null,
  imported_from_turn_id: null,
};
try {
  putTurn(db, turn);
  await client.start();
  await client.drain();
  client.updateTurn({ id: turn.id, status: 'running', channelType: 'web', platformId: 'chat', threadId: null });
  for (let ordinal = 0; ordinal < 128; ordinal++) {
    client.appendActivity({ kind: 'notification', id: `activity-${ordinal}`, text: 'Tool completed' }, ordinal + 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 1100));

  transport.removeAllListeners('end');
  transport.removeAllListeners('close');
  transport.destroy();
  for (let event = 0; event < 89; event++) {
    db.prepare('INSERT INTO session_state(key,value,updated_at) VALUES(?,?,?)').run(
      `runner:recovery:${event}`,
      'complete',
      '2026-10-04T20:33:00.000Z',
    );
  }
  db.prepare(
    `INSERT INTO messages_out(id,seq,timestamp,kind,platform_id,channel_type,thread_id,content,turn_id)
    VALUES('saved-report',1,'2026-10-04 20:33:00','chat','chat','web',NULL,?,'saved-turn')`,
  ).run(JSON.stringify({ text: 'Preserved final report', delivery_origin: 'response', timelinePosition: 1000 }));
  putTurn(db, { ...turn, phase: 'settled', outcome: 'replied', ended_at: '2026-10-04T20:33:00.401Z' });
  if (db.prepare('SELECT count(*) AS n FROM pending_runner_events').get().n !== 91) {
    throw new Error('Expected the original 91-event report/settlement backlog');
  }
  await client.drain(Number.POSITIVE_INFINITY);
  client.updateTurn(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.stdout.write('RECOVERED\n');
} finally {
  client.stop();
  closeSessionDb();
}
