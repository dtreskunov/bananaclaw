import type { TraceLine, TraceStep } from './activity-presentation.js';
import type { ConversationTurn } from './conversation.js';
import { timelineSortKey } from './timeline.js';

export const THINKING_TEXT = 'Thinking\u2026';

function completionMarker(turnId: string, timestamp: string | null): TraceLine {
  const step: TraceStep = {
    kind: 'notification',
    id: `ui:done:${turnId}`,
    text: 'Done',
    status: 'completed',
  };
  const position = timestamp ? timelineSortKey(timestamp) : 0;
  return { ts: position ? String(Math.floor(position / 1000)) : '', text: JSON.stringify(step) };
}

/** Completion is display-only; live Thinking is owned by the current-status projection. */
export function conversationActivity(turn: ConversationTurn): TraceLine[] {
  const lines: TraceLine[] = [...turn.activity].sort((a, b) => a.timelinePosition - b.timelinePosition);
  if (turn.phase === 'settled') {
    lines.push(completionMarker(turn.id, turn.endedAt));
  }
  return lines;
}
