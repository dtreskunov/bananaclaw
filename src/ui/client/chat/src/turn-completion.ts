import type { Conversation } from '../../../shared/conversation';
import type { ChatMessage } from './types';

export function completedResponseId(previous: Conversation | null, messages: ChatMessage[]): string | null {
  const live = new Set(previous?.turns.filter((turn) => turn.phase !== 'settled').map((turn) => turn.id));
  return (
    messages
      .filter(
        (message) =>
          message.direction === 'out' && message.statsTurn?.phase === 'settled' && live.has(message.statsTurn.id),
      )
      .at(-1)?.id ?? null
  );
}

export function responseScrollTop(scrollTop: number, responseTop: number, viewportTop: number): number {
  return Math.max(0, scrollTop + responseTop - viewportTop);
}
