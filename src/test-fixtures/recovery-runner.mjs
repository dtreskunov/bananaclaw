import net from 'node:net';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../../container/agent-runner/src/db/connection.ts';
import { putTurn } from '../../container/agent-runner/src/db/turns.ts';
import { recoverSession } from '../../container/agent-runner/src/recover-session.ts';
import { startSessionSignalClient, stopSessionSignalClient } from '../../container/agent-runner/src/session-link.ts';

const connect = net.createConnection;
net.createConnection = function (...args) {
  if (args[0] === '/run/nanoclaw/runner.sock') args[0] = process.argv[2];
  return connect.apply(this, args);
};
initTestSessionDb({ unifiedHostProjection: true });
const db = getOutboundDb();
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
putTurn(db, turn);
if (process.argv[3] === 'failed') {
  db.prepare('INSERT INTO session_state (key,value,updated_at) VALUES (?,?,?)').run(
    'turn-metadata:saved-turn',
    JSON.stringify({
      turnId: 'saved-turn',
      durationMs: 100,
      model: null,
      usageId: null,
      status: 'unavailable',
      final: true,
    }),
    '2026-10-04T20:33:00.401Z',
  );
  db.prepare(
    `
    INSERT INTO messages_out (id,seq,timestamp,kind,platform_id,channel_type,thread_id,content,turn_id)
    VALUES ('saved-error',1,'2026-10-04 20:33:00','chat','chat','web',NULL,?,'saved-turn')
  `,
  ).run(
    JSON.stringify({
      text: 'Agent provider error: context window exceeds limit (2013)',
      system_generated: true,
      delivery_origin: 'response',
      timelinePosition: 123,
    }),
  );
  putTurn(db, { ...turn, phase: 'settled', outcome: 'failed', ended_at: '2026-10-04T20:33:00.401Z' });
}
try {
  await startSessionSignalClient();
  await recoverSession();
  process.stdout.write('RECOVERED\n');
} finally {
  stopSessionSignalClient();
  closeSessionDb();
}
