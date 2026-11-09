import type { ConversationMessage, ConversationTurn } from '../../../shared/conversation';

const MAX_REPLY_LENGTH = 240;

type DraftInput = Pick<
  HTMLTextAreaElement,
  'value' | 'disabled' | 'readOnly' | 'dispatchEvent' | 'focus' | 'setSelectionRange'
> & { addEventListener(type: 'input', listener: () => void): void };

interface SuggestedDraft {
  scope: string;
  text: string | null;
  filling: boolean;
}

const suggestedDrafts = new WeakMap<DraftInput, SuggestedDraft>();

export function isReplyLabel(text: string): boolean {
  return (
    !!text.trim() &&
    text.length <= MAX_REPLY_LENGTH &&
    ![...text].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 10) || code === 127;
    })
  );
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
  if (!message || message.direction !== 'out' || message.recipient || message.deliveryOrigin !== 'response')
    return false;
  const turn = turns.find((candidate) => candidate.id === message.turnId);
  return (
    turn?.phase === 'settled' &&
    turn.outcome === 'replied' &&
    !messages.slice(index + 1).some((next) => next.direction !== 'event' && next.inputState?.status !== 'cancelled')
  );
}

export function fillSuggestedDraft(
  input: DraftInput | null,
  text: string,
  scope = '',
): { filled: true } | { filled: false; error: string } {
  if (!input || input.disabled || input.readOnly)
    return { filled: false, error: 'The composer is unavailable. Your draft has been kept.' };
  let state = suggestedDrafts.get(input);
  if (input.value.length && (!state || state.scope !== scope || state.text !== input.value))
    return { filled: false, error: 'Finish or clear your draft to try a suggestion.' };
  if (!state) {
    const tracked: SuggestedDraft = { scope, text, filling: false };
    suggestedDrafts.set(input, tracked);
    input.addEventListener('input', () => {
      if (!tracked.filling) tracked.text = null;
    });
    state = tracked;
  }
  state.scope = scope;
  state.text = text;
  input.value = text;
  state.filling = true;
  try {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } finally {
    state.filling = false;
  }
  input.focus();
  input.setSelectionRange(text.length, text.length);
  return { filled: true };
}
