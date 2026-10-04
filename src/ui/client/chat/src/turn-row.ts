import type { ConversationTurn } from '../../../shared/conversation';
import type { ActiveTurn } from './types';

export function activeTurnNotices(
  turn: ActiveTurn | null,
  connected: boolean,
  stop: { turnId: string; error: string } | null,
): Array<{ text: string; error: boolean }> {
  if (!turn) return [];
  const error = stop?.turnId === turn.id ? stop.error : '';
  const notices: Array<{ text: string; error: boolean }> = [];
  if (error) notices.push({ text: error, error: true });
  if (turn.status === 'stopping') notices.push({ text: 'Stopping…', error: false });
  if (!connected && !error) notices.push({ text: 'Runner disconnected.', error: false });
  return notices;
}

/** Only outcomes that change how the reply should be read get a label; a normal reply speaks for itself. */
const OUTCOME_NOTES: Partial<Record<ConversationTurn['outcome'], string>> = {
  stopped: 'Stopped',
  failed: 'Failed',
  warning: 'Ended with a warning',
  interrupted: 'Interrupted; outcome unknown',
  silent: 'No reply',
};

export interface TurnRowView {
  /** Settled with nothing to show: no trace, accounting, timing or notable outcome. */
  hidden: boolean;
  /** Fallback headline while unsettled and no activity has arrived yet. */
  status: string | null;
  note: string | null;
  elapsedMs: number | null;
  model: string | null;
  /** The elapsed/model line; settled usage summaries already carry both. */
  showTiming: boolean;
  showTokensUnavailable: boolean;
  usage: ConversationTurn['usage'];
}

export function turnRowView(turn: ConversationTurn, now: number): TurnRowView {
  const settled = turn.phase === 'settled';
  const startedAt = turn.startedAt ? Date.parse(turn.startedAt) : NaN;
  const endedAt = turn.endedAt ? Date.parse(turn.endedAt) : NaN;
  const elapsedMs = settled
    ? (turn.metadata.durationMs ??
      (Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : null))
    : Number.isFinite(startedAt)
      ? Math.max(0, now - startedAt)
      : null;
  const model = turn.metadata.model;
  const note = settled ? (OUTCOME_NOTES[turn.outcome] ?? null) : turn.phase === 'stopping' ? 'Stopping…' : null;
  const hasTiming = elapsedMs !== null || !!model;
  return {
    hidden: settled && !turn.activity.length && !turn.usage.length && !hasTiming && !note,
    status: !settled && turn.phase === 'running' ? 'Working…' : null,
    note,
    elapsedMs,
    model,
    showTiming: !settled || !turn.usage.length,
    showTokensUnavailable: settled && !turn.usage.length && hasTiming,
    // While running, the live line owns elapsed time and model; checkpointed values would be stale.
    usage: settled
      ? turn.usage
      : turn.usage.map(({ id, value }) => ({ id, value: { ...value, duration_ms: undefined, model: undefined } })),
  };
}
