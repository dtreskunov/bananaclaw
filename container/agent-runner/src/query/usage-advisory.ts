import type { AgentQuery, ProviderEvent } from '../providers/types.js';
import { persistTurnMetadata, turnUsage, type TurnExecution } from '../turn-execution.js';
import { transitionUsageAdvisory } from '../providers/usage.js';

export function offerUsageAdvisory(turn: TurnExecution, query: AgentQuery, threshold?: number): void {
  if (threshold === undefined || turn.usageAdvisory || turn.settled || !query.adviseUsage) return;
  const reportedTokens = turnUsage(turn)?.reported_tokens;
  if (reportedTokens === undefined || reportedTokens < threshold) return;
  turn.usageAdvisory = {
    threshold,
    reportedTokens,
    triggeredAt: Date.now(),
    status: 'queued',
    appliedAt: null,
    finishedAt: null,
  };
  persistTurnMetadata(turn, false);
  const accepted = query.adviseUsage({
    turnId: turn.turnId,
    prompt:
      `Turn usage advisory: this turn has consumed approximately ${reportedTokens} reported tokens, ` +
      `meeting or exceeding its ${threshold}-token soft budget. This is not a measurement of remaining provider quota.\n\n` +
      'Wrap up now. If the task is nearly complete, finish with minimal additional work. Otherwise, report what is completed, ' +
      'what remains, and any uncertain or ongoing side effects, then end this turn and wait for the user.\n\n' +
      'Do not start new exploratory work, delegate further work, or schedule an automatic continuation.',
  });
  if (!accepted) {
    turn.usageAdvisory = transitionUsageAdvisory(turn.usageAdvisory, 'skipped', Date.now());
    console.error('[usage-advisory] Provider could not accept wrap-up guidance for the active turn');
    persistTurnMetadata(turn, false);
  }
}

export function recordUsageAdvisory(
  turn: TurnExecution,
  event: Extract<ProviderEvent, { type: 'usage_advisory' }>,
): boolean {
  const advisory = turn.usageAdvisory;
  if (turn.turnId !== event.turnId || !advisory) throw new Error('Provider acknowledged an unrelated usage advisory');
  if (advisory.status !== 'queued') return false;
  turn.usageAdvisory = transitionUsageAdvisory(advisory, event.status, event.timestamp);
  persistTurnMetadata(turn, false);
  return true;
}
