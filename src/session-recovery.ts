import fs from 'node:fs';
import type Database from 'better-sqlite3';

import { openOutboundDb, runnerStateDbPath } from './session-manager.js';
import type { Session } from './types.js';

export function needsStoppedRunnerRecovery(session: Session, outbound?: Database.Database): boolean {
  const db = outbound ?? openOutboundDb(session.agent_group_id, session.id);
  try {
    const needed =
      session.container_status === 'running' ||
      !!db
        .prepare(
          `
      SELECT 1 FROM turns WHERE phase != 'settled'
      UNION ALL
      SELECT 1 FROM processing_ack WHERE status = 'processing'
      LIMIT 1
    `,
        )
        .get();
    if (needed && !fs.existsSync(runnerStateDbPath(session.agent_group_id, session.id))) {
      throw new Error(`Cannot recover stopped runner: runner-state database is missing for ${session.id}`);
    }
    return needed;
  } finally {
    if (!outbound) db.close();
  }
}
