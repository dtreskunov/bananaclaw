import type { ConversationTurn } from '../../../shared/conversation';
import {
  isSyntheticTraceStep,
  parseStep,
  stepHeadline,
  type StepHeadline,
  type TraceLine,
  type TraceStep,
} from '../../../shared/activity-presentation';
import { THINKING_TEXT } from '../../../shared/conversation-activity';
import type { ActiveTurn } from './types';

export function currentActivityHeadline(lines: readonly TraceLine[]): StepHeadline {
  const seen = new Set<string>();
  for (let index = lines.length - 1; index >= 0; index--) {
    const step = parseStep(lines[index].text);
    if (isSyntheticTraceStep(step)) continue;
    if (step.id) {
      const id = `${step.kind}:${step.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
    }
    if (step.status !== 'running' && step.status !== 'pending') continue;
    const headline = stepHeadline(step);
    if (headline.action || headline.subject) return headline;
  }
  return { action: THINKING_TEXT };
}

export function liveTurnActivity(
  turn: Pick<ConversationTurn, 'id' | 'phase'>,
  lines: TraceLine[],
  connected: boolean,
  stop: { turnId: string; error: string } | null,
): { lines: TraceLine[]; headline: StepHeadline; notice: boolean; error: boolean } | null {
  if (turn.phase === 'settled') return null;
  const notices = activeTurnNotices(
    {
      id: turn.id,
      status: turn.phase === 'stopping' ? 'stopping' : 'running',
    },
    connected,
    stop,
  );
  const current = notices.length
    ? { action: notices.map((notice) => notice.text).join(' \u00b7 ') }
    : currentActivityHeadline(lines);
  const presentation = { notice: notices.length > 0, error: notices.some((notice) => notice.error) };
  if (!notices.length) return { lines, headline: current, ...presentation };
  const marker: TraceStep = {
    kind: 'notification',
    id: `ui:current:${turn.id}`,
    text: current.action,
    status: presentation.error ? 'error' : !connected ? 'interrupted' : 'running',
  };
  return {
    ...presentation,
    lines: [...lines, { ts: '', text: JSON.stringify(marker) }],
    headline: current,
  };
}

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
  if (!connected && !error) notices.push({ text: 'Runner disconnected', error: false });
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
  /** Fallback headline while running without current activity. */
  status: string | null;
  note: string | null;
  elapsedMs: number | null;
  model: string | null;
  /** Settled usage summaries already carry the model. */
  showModel: boolean;
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
    status: !settled && turn.phase === 'running' ? THINKING_TEXT : null,
    note,
    elapsedMs,
    model,
    showModel: !settled || !turn.usage.length,
    showTokensUnavailable: settled && !turn.usage.length && hasTiming,
    // While running, the live line owns elapsed time and model; checkpointed values would be stale.
    usage: settled
      ? turn.usage
      : turn.usage.map(({ id, value }) => ({ id, value: { ...value, duration_ms: undefined, model: undefined } })),
  };
}
