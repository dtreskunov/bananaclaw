/**
 * Runner-authored chat rows that close a turn: the "Stopped by user." notice
 * and the warning shown when a turn ends having delivered nothing.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { appendActivity, clearFailedTurn, getActivityBuffer, setTurnEnded } from '../db/session-state.js';
import { writeTurnCheckpoint } from '../db/turn-checkpoints.js';
import { waitForTurnTools } from '../current-batch.js';
import type { RoutingContext } from '../formatter.js';
import type { ActivityStep } from '../providers/types.js';
import { drainSessionJournal } from '../session-link.js';
import { settleTurn, type TurnExecution } from '../turn-execution.js';
import type { TerminalNotice } from './recovery.js';

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeResponseRow(routing: RoutingContext, text: string, extra: Record<string, unknown>): string {
  const id = generateId();
  writeMessageOut({
    id,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text, delivery_origin: 'response', ...extra }),
  });
  return id;
}

/** Write a warning for a turn that delivered nothing and settle it as a warning. */
export async function writeTurnNotice(execution: TurnExecution, notice: TerminalNotice): Promise<void> {
  try {
    await waitForTurnTools(execution);
    execution.endedAt ??= new Date().toISOString();
    writeResponseRow(notice.routing, notice.text, {
      suggested_action: notice.action,
      system_generated: true,
    });
    if (!execution.failure) await settleTurn(execution, 'warning');
  } catch (e) {
    log(`Failed to write ${notice.label}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/**
 * Close a turn the user stopped: mark tools still running as interrupted
 * (their outcome is unknown), write the stopped notice, anchor the provider
 * checkpoint on it, and settle the turn once the journal is drained.
 */
export async function finalizeStoppedTurn(opts: {
  execution: TurnExecution;
  routing: RoutingContext;
  providerName: string;
  continuation: string | undefined;
  checkpoint: string | null;
}): Promise<void> {
  const { execution } = opts;
  await waitForTurnTools(execution);
  execution.endedAt = new Date().toISOString();
  const latestTools = new Map<string, ActivityStep>();
  for (const line of getActivityBuffer()) {
    try {
      const step = JSON.parse(line.text) as ActivityStep;
      if (step.kind === 'tool') latestTools.set(step.id, step);
    } catch {
      /* legacy activity text */
    }
  }
  for (const step of latestTools.values()) {
    if (step.kind === 'tool' && (step.status === 'running' || step.status === 'pending')) {
      appendActivity({
        ...step,
        status: 'interrupted',
        error: 'Interrupted; outcome unknown. External side effects may have occurred.',
      });
    }
  }
  appendActivity({ kind: 'notification', id: `stopped:${execution.turnId}`, text: 'Stopped by user.' });
  const noticeId = writeResponseRow(opts.routing, 'Stopped by user.', {
    stopped: true,
    turn_id: execution.turnId,
    system_generated: true,
  });
  if (opts.checkpoint && opts.continuation) {
    writeTurnCheckpoint(noticeId, opts.providerName, opts.continuation, opts.checkpoint);
  }
  clearFailedTurn();
  await settleTurn(execution, 'stopped');
  await drainSessionJournal();
  setTurnEnded();
}
