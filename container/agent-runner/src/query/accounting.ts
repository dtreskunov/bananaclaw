/**
 * Usage and provider-checkpoint bookkeeping for one query. Usage is captured
 * from provider events and persisted as turn metadata at each result
 * boundary; the checkpoint lands on the last outbound row of that turn so a
 * later fork can branch at exactly that message.
 */
import { getOutboundDb } from '../db/connection.js';
import { clearActivity, clearUsageProgress, writeUsageProgress } from '../db/session-state.js';
import { writeTurnCheckpoint } from '../db/turn-checkpoints.js';
import type { AgentProvider, CallUsage, TurnUsage } from '../providers/types.js';
import { accumulateTurnUsage } from '../providers/usage.js';
import { persistTurnMetadata, recordTurnUsage, turnUsage, type TurnExecution } from '../turn-execution.js';

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

/** Clear the live activity trace and usage progress for a fresh turn. Best-effort. */
export function resetLiveTurnState(): void {
  try {
    clearActivity();
  } catch {
    /* best-effort */
  }
  try {
    clearUsageProgress();
  } catch {
    /* best-effort */
  }
}

export class TurnAccounting {
  // Accumulated from `usage` events; flushed at the result boundary.
  private pendingUsage: TurnUsage | null = null;
  // Captured from the provider's `checkpoint` event; flushed with the usage.
  checkpoint: string | null = null;

  constructor(private readonly execution: { current: TurnExecution }) {}

  onUsage(data: TurnUsage): void {
    // Provider reports an attempt aggregate, replacing its live call deltas.
    // Accumulated, not replaced: a turn that retried, or that errored and
    // was re-prompted, emits one event per attempt and every attempt was
    // billed. Non-additive fields take the latest attempt's value.
    this.pendingUsage = accumulateTurnUsage(this.pendingUsage, data);
    recordTurnUsage(this.execution.current, data, true);
  }

  onUsageCall(data: CallUsage): void {
    recordTurnUsage(this.execution.current, data, false);
    try {
      writeUsageProgress(turnUsage(this.execution.current)!);
    } catch {
      /* best-effort */
    }
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
    const pending = this.pendingUsage;
    if (pending) {
      // Providers that resolve limits from a remote catalog fill them in
      // here rather than mid-turn, so enrichment is uniform and a slow
      // catalog can never stall the reply. Gaps only: a provider whose
      // SDK already reported limits keeps its own numbers.
      try {
        const limits = await opts.provider.modelLimits?.(pending);
        if (pending.context_window === undefined && limits?.context_window !== undefined) {
          pending.context_window = limits.context_window;
        }
        if (pending.max_output_tokens === undefined && limits?.max_output_tokens !== undefined) {
          pending.max_output_tokens = limits.max_output_tokens;
        }
      } catch (e) {
        log(`Failed to resolve model limits: ${e instanceof Error ? e.message : String(e)}`);
      }
      const execution = this.execution.current;
      if (execution.reportedUsage) {
        execution.reportedUsage = {
          ...execution.reportedUsage,
          context_window: pending.context_window,
          max_output_tokens: pending.max_output_tokens,
        };
      }
      persistTurnMetadata(execution, false);
      this.pendingUsage = null;
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
