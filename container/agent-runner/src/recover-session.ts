import { getOutboundDb } from './db/connection.js';
import { markBatchPersisted } from './db/runner-state.js';
import { drainSessionJournal, signalTurnState } from './session-link.js';
import { interruptAbandonedTurns } from './turn-execution.js';

export async function recoverSession(drain: () => Promise<void> = drainSessionJournal): Promise<void> {
  // Replay the recorded outcome before deciding whether any turn was abandoned.
  await drain();
  interruptAbandonedTurns();
  markBatchPersisted(getOutboundDb());
  await drain();
  signalTurnState(null);
}
