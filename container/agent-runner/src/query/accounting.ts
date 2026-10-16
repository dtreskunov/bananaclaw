/**
 * Usage and provider-checkpoint bookkeeping for one query. Usage is captured
 * from provider events and persisted as turn metadata at each result
 * boundary; the checkpoint lands on the last outbound row of that turn so a
 * later fork can branch at exactly that message.
 */
import { getOutboundDb } from '../db/connection.js';
import { clearActivity } from '../db/session-state.js';
import { writeTurnCheckpoint } from '../db/turn-checkpoints.js';
import type { AgentProvider, CallUsage } from '../providers/types.js';
import { completeUsageAttempt, recordCallUsage, turnUsage, type TurnExecution } from '../turn-execution.js';

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

/** Clear the live activity trace for a fresh turn. Best-effort. */
export function resetLiveTurnState(): void {
  try {
    clearActivity();
  } catch {
    /* best-effort */
  }
}

export class TurnAccounting {
  // Captured from the provider's `checkpoint` event; flushed with the usage.
  checkpoint: string | null = null;

  constructor(private readonly execution: { current: TurnExecution }) {}

  /** Returns false when the call replaced an earlier report of the same call. */
  onUsageCall(data: CallUsage): boolean {
    return recordCallUsage(this.execution.current, data);
  }

  /**
   * Persist the turn's usage and link the checkpoint to the last outbound row
   * written since `since`. A turn with no outbound row keeps its usage but
   * cannot anchor a checkpoint: fork anchors are picked from UI messages.
   */
  async flushAtResult(opts: {
    provider: AgentProvider;
    providerName: string;
    continuation: string | undefined;
    since: number;
    turnId: string;
  }): Promise<void> {
    const lastOutId =
      (
        getOutboundDb()
          .prepare('SELECT id FROM messages_out WHERE seq > ? AND turn_id = ? ORDER BY seq DESC LIMIT 1')
          .get(opts.since, opts.turnId) as { id: string } | undefined
      )?.id ?? '';
    const execution = this.execution.current;
    if (execution.unreported) {
      // Providers that resolve limits from a remote catalog fill them in
      // here rather than mid-turn, so enrichment is uniform and a slow
      // catalog can never stall the reply. Gaps only: a provider whose
      // calls already reported limits keeps its own numbers.
      let limits: TurnExecution['limits'] = {};
      const usage = turnUsage(execution);
      if (usage && (usage.context_window === undefined || usage.max_output_tokens === undefined)) {
        try {
          limits = (await opts.provider.modelLimits?.(usage)) ?? {};
        } catch (e) {
          log(`Failed to resolve model limits: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      completeUsageAttempt(execution, limits);
    }
    if (this.checkpoint && lastOutId && opts.continuation) {
      try {
        writeTurnCheckpoint(lastOutId, opts.providerName, opts.continuation, this.checkpoint);
      } catch (e) {
        log(`Failed to write turn_checkpoints: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.checkpoint = null;
  }
}
