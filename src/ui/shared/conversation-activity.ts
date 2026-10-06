import type { TraceLine } from './activity-presentation.js';
import type { ConversationTurn } from './conversation.js';

export const THINKING_TEXT = 'Thinking\u2026';

export function conversationActivity(turn: ConversationTurn): TraceLine[] {
  return [...turn.activity].sort((a, b) => a.timelinePosition - b.timelinePosition);
}
