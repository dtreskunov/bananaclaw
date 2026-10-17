import { parseStep, type ModelTime, type TraceLine, type TraceStep } from './activity-presentation.js';
import type { ConversationTurn } from './conversation.js';

export const THINKING_TEXT = 'Thinking\u2026';
export const QUEUED_TEXT = 'Queued\u2026';
export const PREPARING_TEXT = 'Preparing\u2026';
export const STARTED_TURN_TEXT = 'Started response';
const TURN_START = -1;

const TERMINAL_OUTCOMES: Partial<Record<ConversationTurn['outcome'], string>> = {
  stopped: 'Stopped by user',
  warning: 'Ended with a warning',
  interrupted: 'Interrupted; outcome unknown',
  silent: 'No reply',
};

export function terminalOutcomeStep(turn: ConversationTurn): TraceStep | null {
  if (turn.phase !== 'settled') return null;
  const text = TERMINAL_OUTCOMES[turn.outcome];
  if (!text) return null;
  if (
    turn.outcome === 'stopped' &&
    turn.activity.some((line) => {
      const step = parseStep(line.text);
      return step.kind === 'notification' && step.id === `stopped:${turn.id}`;
    })
  )
    return null;
  return {
    kind: 'notification',
    id: `ui:outcome:${turn.id}`,
    text,
    ...(turn.outcome === 'interrupted' ? { status: 'interrupted' } : {}),
  };
}

export function conversationActivity(turn: ConversationTurn, activity = turn.activity): TraceLine[] {
  const lines: TraceLine[] = [...activity].sort((a, b) => a.timelinePosition - b.timelinePosition);
  const outcome = terminalOutcomeStep(turn);
  if (!outcome) return lines;
  const endedAt = turn.endedAt ? Date.parse(turn.endedAt) : NaN;
  return [
    ...lines,
    {
      ts: Number.isFinite(endedAt) ? String(endedAt) : '',
      text: JSON.stringify(outcome),
    },
  ];
}

/** When the turn was requested (its earliest submission), falling back to its start. */
export function turnRequestedAt(turn: Pick<ConversationTurn, 'requestedAt' | 'startedAt'>): number {
  const requestedAt = turn.requestedAt ? Date.parse(turn.requestedAt) : NaN;
  if (Number.isFinite(requestedAt)) return requestedAt;
  return turn.startedAt ? Date.parse(turn.startedAt) : NaN;
}

// Reported call starts are derived from end minus duration, so allow a little clock skew.
const CALL_START_SLACK_MS = 250;

/**
 * Model time per trace row, keyed by ordinal (or the turn start). Each reported
 * model call is attributed to the step whose end preceded the call's start,
 * i.e. the step that prompted it. Once the first model call can start, while
 * live and no step is running, the time since the latest step or call ended
 * ticks on its owner.
 */
export function turnModelTime(turn: ConversationTurn): Map<number, ModelTime> {
  const times = new Map<number, ModelTime>();
  const startedAt = turn.startedAt ? Date.parse(turn.startedAt) : NaN;
  if (!Number.isFinite(startedAt)) return times;
  const live = turn.phase !== 'settled';
  const entries = turn.activity
    .map((line) => ({ ordinal: line.ordinal, at: Number(line.ts), step: parseStep(line.text) }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);
  const calls = entries.filter(({ step }) => step.kind === 'model');
  const steps = entries
    .filter(({ step }) => step.kind !== 'model')
    .map(({ ordinal, at, step }) => {
      const open =
        live &&
        (step.kind === 'tool' || step.kind === 'compaction') &&
        (step.status === 'running' || step.status === 'pending');
      // Steps recorded before the turn start still end no earlier than it.
      return { ordinal, at, end: open ? Infinity : Math.max(startedAt, at + (step.durationMs ?? 0)) };
    });
  const add = (owner: number, ms: number, since?: number) => {
    const prior = times.get(owner);
    times.set(owner, {
      ms: (prior?.ms ?? 0) + ms,
      ...(since !== undefined ? { since } : {}),
    });
  };
  /** The step that last finished by `at`; later-recorded steps win ties. */
  const ownerAt = (at: number) =>
    steps.reduce<{ ordinal: number; end: number } | null>(
      (best, step) => (step.end <= at && (!best || step.end >= best.end) ? step : best),
      null,
    )?.ordinal ?? TURN_START;
  for (const { at, step } of calls)
    add(ownerAt(at - (step.durationMs ?? 0) + CALL_START_SLACK_MS), step.durationMs ?? 0);
  if (live && calls.length && !steps.some(({ end }) => end === Infinity)) {
    const lastStep = Math.max(startedAt, ...steps.map(({ end }) => end));
    add(ownerAt(lastStep), 0, Math.max(lastStep, ...calls.map(({ at }) => at)));
  }
  return times;
}

/**
 * Attaches model time to a trace segment and drops the hidden model-call rows;
 * the segment holding the turn start gets a synthetic first row. That row reads
 * Preparing… from runner pickup until the first model call can start (its
 * execution time), then Thinking… while that call's model time ticks on it.
 * Queueing before pickup counts toward the turn total only.
 */
export function withModelTime(
  turn: ConversationTurn,
  lines: TraceLine[],
  times: Map<number, ModelTime>,
  hostsStart: boolean,
): TraceLine[] {
  const timed = lines
    .filter((line) => parseStep(line.text).kind !== 'model')
    .map((line) => {
      const modelTime = line.ordinal === undefined ? undefined : times.get(line.ordinal);
      return modelTime ? { ...line, modelTime } : line;
    });
  const startedAt = turn.startedAt ? Date.parse(turn.startedAt) : NaN;
  if (!hostsStart || !Number.isFinite(startedAt)) return timed;
  const modelTime = times.get(TURN_START);
  // The readiness marker (or first model call) ends preparation.
  const callStarts = turn.activity.flatMap(({ ts, text }) => {
    const step = parseStep(text);
    const at = Number(ts);
    return step.kind === 'model' && Number.isFinite(at) ? [at - (step.durationMs ?? 0)] : [];
  });
  const prepared = callStarts.length ? { durationMs: Math.max(0, Math.min(...callStarts) - startedAt) } : {};
  const live = turn.phase !== 'settled';
  const text = !live
    ? STARTED_TURN_TEXT
    : !callStarts.length
      ? PREPARING_TEXT
      : modelTime?.since !== undefined
        ? THINKING_TEXT
        : STARTED_TURN_TEXT;
  const step: TraceStep = {
    kind: 'notification',
    id: `ui:start:${turn.id}`,
    text,
    status: text === STARTED_TURN_TEXT ? 'completed' : 'running',
    ...prepared,
  };
  return [{ ts: String(startedAt), text: JSON.stringify(step), ...(modelTime ? { modelTime } : {}) }, ...timed];
}

/** The synthetic start row; its execution time is the wait before the first model call. */
export function isTurnStartStep(step: TraceStep): boolean {
  return step.kind === 'notification' && !!step.id?.startsWith('ui:start:');
}
