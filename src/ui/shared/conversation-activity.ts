import type { TraceLine, TraceStep } from './activity-presentation.js';
import type { ConversationTurn } from './conversation.js';
import { timelineSortKey } from './timeline.js';

/** The display-only completion marker never becomes a runner activity or accounting record. */
export function conversationActivity(turn: ConversationTurn): TraceLine[] {
  const lines: TraceLine[] = [...turn.activity].sort((a, b) => a.timelinePosition - b.timelinePosition);
  if (turn.phase === 'settled') {
    const step: TraceStep = { kind: 'notification', id: `ui:done:${turn.id}`, text: 'Done' };
    const position = timelineSortKey(turn.endedAt ?? '');
    lines.push({ ts: position ? String(Math.floor(position / 1000)) : '', text: JSON.stringify(step) });
  }
  return lines;
}
