import type { ConversationTurn } from '../../../shared/conversation';
import {
  activityChapters,
  isOutcomeTraceStep,
  parseStep,
  type TraceChapter,
  type StepHeadline,
  type TraceLine,
  type TraceStep,
} from '../../../shared/activity-presentation';
import { terminalOutcomeStep, THINKING_TEXT, turnRequestedAt } from '../../../shared/conversation-activity';
import { activityTimestamp } from '../../../shared/activity-timing';
import type { ActiveTurn } from './types';

export interface TraceHeadline {
  headline: StepHeadline;
  repetitions: number;
}

/** The trace's latest row as the trace list shows it (grouped chapter or single step); outcome rows never lead. */
export function latestTraceHeadline(chapters: readonly TraceChapter[]): TraceHeadline {
  const chapter = [...chapters]
    .reverse()
    .find((candidate) => candidate.entries.some((entry) => !isOutcomeTraceStep(entry.step)));
  if (!chapter) return { headline: { action: THINKING_TEXT }, repetitions: 1 };
  return { headline: chapter.headline, repetitions: chapter.entries.length };
}

export function liveTurnActivity(
  turn: Pick<ConversationTurn, 'id' | 'phase'>,
  lines: TraceLine[],
  chapters: TraceChapter[],
  connected: boolean,
  stop: { turnId: string; error: string } | null,
): {
  lines: TraceLine[];
  chapters: TraceChapter[];
  headline: StepHeadline;
  repetitions: number;
  notice: boolean;
  error: boolean;
} | null {
  if (turn.phase === 'settled') return null;
  const notices = activeTurnNotices(
    {
      id: turn.id,
      status: turn.phase === 'stopping' ? 'stopping' : 'running',
    },
    connected,
    stop,
  );
  const presentation = { notice: notices.length > 0, error: notices.some((notice) => notice.error) };
  if (!notices.length) return { lines, chapters, ...latestTraceHeadline(chapters), ...presentation };
  const current = { action: notices.map((notice) => notice.text).join(' \u00b7 ') };
  const marker: TraceStep = {
    kind: 'notification',
    id: `ui:current:${turn.id}`,
    text: current.action,
    status: presentation.error ? 'error' : !connected ? 'interrupted' : 'running',
  };
  const line = { ts: '', text: JSON.stringify(marker) };
  return {
    ...presentation,
    lines: [...lines, line],
    chapters: [...chapters, ...activityChapters([line], true)],
    headline: current,
    repetitions: 1,
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
  return view.usage.length > 0 || (turn.phase === 'settled' && (view.elapsedMs !== null || !!view.model));
}

function toolCallMs(turn: ConversationTurn, now: number): number {
  const live = turn.phase !== 'settled';
  let unplacedMs = 0;
  const spans = turn.activity
    .flatMap(({ ts, text }): Array<[number, number]> => {
      const step = parseStep(text);
      const at = activityTimestamp(ts);
      if (step.kind !== 'tool') return [];
      if (!Number.isFinite(at)) {
        unplacedMs += step.durationMs ?? 0;
        return [];
      }
      if (step.status === 'running') return live ? [[at, Math.max(at, now)]] : [];
      return step.durationMs !== undefined ? [[at, at + step.durationMs]] : [];
    })
    .sort((a, b) => a[0] - b[0]);
  let total = unplacedMs;
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
  // Total runs from submission; the wait before the turn started counts.
  const requestedAt = turnRequestedAt(turn);
  const waitedMs =
    Number.isFinite(startedAt) && Number.isFinite(requestedAt) ? Math.max(0, startedAt - requestedAt) : 0;
  const ranMs = settled
    ? (turn.metadata.durationMs ??
      (Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : null))
    : null;
  const elapsedMs = settled
    ? ranMs === null
      ? null
      : ranMs + waitedMs
    : Number.isFinite(requestedAt)
      ? Math.max(0, now - requestedAt)
      : null;
  const model = turn.metadata.model;
  const timings = turn.usage.map(({ value }) => value.duration_api_ms);
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
