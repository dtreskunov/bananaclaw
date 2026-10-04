import type { TraceLine, TraceStep } from './activity-presentation.js';
import type { ConversationQuestion, ConversationTurn } from './conversation.js';
import { timelineSortKey } from './timeline.js';

function marker(id: string, text: string, timestamp: string, detail?: string): TraceLine {
  const step: TraceStep = { kind: 'notification', id, text, ...(detail ? { detail } : {}) };
  const position = timelineSortKey(timestamp);
  return { ts: position ? String(Math.floor(position / 1000)) : '', text: JSON.stringify(step) };
}

/** Display-only conversation events never become runner activities or accounting records. */
export function conversationActivity(turn: ConversationTurn, questions: ConversationQuestion[]): TraceLine[] {
  const entries: Array<{ line: TraceLine; position: number }> = turn.activity.map((line) => ({
    line,
    position: line.timelinePosition,
  }));
  for (const question of questions) {
    if (
      question.turnId !== turn.id &&
      (question.turnId || !question.messageId || !turn.outputIds.includes(question.messageId))
    )
      continue;
    entries.push({
      line: marker(`ui:question:${question.questionId}`, 'Asked a question', question.createdAt, question.question),
      position: timelineSortKey(question.createdAt, question.timelinePosition),
    });
  }
  const lines = entries.sort((a, b) => a.position - b.position).map(({ line }) => line);
  if (turn.phase === 'settled') lines.push(marker(`ui:done:${turn.id}`, 'Done', turn.endedAt ?? ''));
  return lines;
}
