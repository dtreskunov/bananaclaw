import type { ConversationMessage, ConversationTurn } from '../../../shared/conversation';
import { MAX_SUGGESTED_RESPONSE_LENGTH } from '../../../shared/suggested-responses';

export function inlineReplyDraft(href: string): string | null {
  if (!/^reply:/i.test(href)) return null;
  try {
    const text = decodeURIComponent(href.slice('reply:'.length));
    const control = [...text].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 10) || code === 127;
    });
    return text.trim() && text.length <= MAX_SUGGESTED_RESPONSE_LENGTH && !control ? text : null;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

export function suggestionsActive(
  messageId: string,
  messages: readonly ConversationMessage[],
  turns: readonly ConversationTurn[],
  sending: boolean,
): boolean {
  if (sending || turns.some((turn) => turn.phase !== 'settled')) return false;
  const index = messages.findIndex((message) => message.id === messageId);
  const message = messages[index];
  if (!message || message.direction !== 'out' || message.deliveryOrigin !== 'response') return false;
  const turn = turns.find((candidate) => candidate.id === message.turnId);
  return (
    turn?.phase === 'settled' &&
    turn.outcome === 'replied' &&
    !messages.slice(index + 1).some((next) => next.direction !== 'event' && next.inputState?.status !== 'cancelled')
  );
}

export function fillSuggestedDraft(
  input: Pick<
    HTMLTextAreaElement,
    'value' | 'disabled' | 'readOnly' | 'dispatchEvent' | 'focus' | 'setSelectionRange'
  > | null,
  text: string,
): { filled: true } | { filled: false; error: string } {
  if (!input || input.disabled || input.readOnly)
    return { filled: false, error: 'The composer is unavailable. Your draft has been kept.' };
  if (input.value.length)
    return { filled: false, error: 'Your draft has been kept. Clear it before choosing a suggested reply.' };
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(text.length, text.length);
  return { filled: true };
}
