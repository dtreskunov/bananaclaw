import { parseStep, type TraceLine, type TraceStep } from './activity-presentation.js';
import type { ConversationTurn } from './conversation.js';

export const THINKING_TEXT = 'Thinking\u2026';

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
