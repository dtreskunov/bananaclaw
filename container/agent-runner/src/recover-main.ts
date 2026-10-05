import { closeSessionDb, getOutboundDb } from './db/connection.js';
import { recoverSession } from './recover-session.js';
import { startSessionSignalClient, stopSessionSignalClient } from './session-link.js';

async function main(): Promise<void> {
  getOutboundDb();
  try {
    await startSessionSignalClient();
    await recoverSession();
    console.error('[session-recovery] Runner journal recovered');
  } finally {
    stopSessionSignalClient();
    closeSessionDb();
  }
}

main().catch((error: unknown) => {
  console.error('[session-recovery] Recovery failed', error);
  process.exitCode = 1;
});
