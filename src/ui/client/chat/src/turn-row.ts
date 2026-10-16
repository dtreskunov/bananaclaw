import type { ConversationTurn } from '../../../shared/conversation';
import {
  isSyntheticTraceStep,
  parseStep,
  stepHeadline,
  type StepHeadline,
  type TraceLine,
  type TraceStep,
} from '../../../shared/activity-presentation';
import { terminalOutcomeStep, THINKING_TEXT } from '../../../shared/conversation-activity';
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

export interface TurnRowView {
  /** Settled with nothing to show: no trace, accounting, timing or notable outcome. */
  hidden: boolean;
  /** Fallback headline while running without current activity. */
  status: string | null;
  elapsedMs: number | null;
  modelCallMs: number | null;
  /** Time with at least one tool running; parallel tools count once. */
  toolCallMs: number;
  model: string | null;
  usage: ConversationTurn['usage'];
}

export function hasTurnStats(turn: ConversationTurn, view: TurnRowView): boolean {
  return (
    view.usage.length > 0 || (turn.phase === 'settled' ? view.elapsedMs !== null || !!view.model : !!turn.liveUsage)
  );
}

function toolCallMs(turn: ConversationTurn, now: number): number {
  const live = turn.phase !== 'settled';
  const spans = turn.activity
    .flatMap(({ ts, text }): Array<[number, number]> => {
      const step = parseStep(text);
      const at = Number(ts);
      if (step.kind !== 'tool' || !Number.isFinite(at)) return [];
      if (step.status === 'running') return live ? [[at, Math.max(at, now)]] : [];
      return step.durationMs !== undefined ? [[at, at + step.durationMs]] : [];
    })
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let covered = -Infinity;
  for (const [from, to] of spans) {
    if (to <= covered) continue;
    total += to - Math.max(from, covered);
    covered = to;
  }
  return total;
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
  const timings = turn.usage.length
    ? turn.usage.map(({ value }) => value.duration_api_ms)
    : turn.liveUsage
      ? [turn.liveUsage.duration_api_ms]
      : [];
  const modelCallMs =
    timings.length && timings.every((value) => value !== undefined)
      ? timings.reduce((total, value) => total + value, 0)
      : null;
  const hasTiming = elapsedMs !== null || !!model;
  return {
    hidden: settled && !turn.activity.length && !terminalOutcomeStep(turn) && !turn.usage.length && !hasTiming,
    status: !settled && turn.phase === 'running' ? THINKING_TEXT : null,
    elapsedMs,
    modelCallMs,
    toolCallMs: toolCallMs(turn, now),
    model,
    // While running, the live line owns elapsed time and model; checkpointed values would be stale.
    usage: settled
      ? turn.usage
      : turn.usage.map(({ id, value }) => ({ id, value: { ...value, duration_ms: undefined, model: undefined } })),
  };
}
