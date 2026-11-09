import { suggestionsActive, fillSuggestedDraft } from '../reply-suggestions';
import { conversationState } from '../conversation-state';
import { canSend, channelType, groupId, messagingGroupId, pendingWebSends, threadId } from '../state';
import { composerSendInFlight, currentPendingEditor } from '../pending-edit';
import { isRecording } from '../recorder';
import { voice } from '../voice-audio';
import type { ChatMessage } from '../types';
import { showToast } from './Toast';

function suggestionState(messageId: string) {
  const conversation = conversationState.value?.conversation;
  const sending = pendingWebSends.value.some(
    (send) => send.groupId === groupId.value && send.threadId === threadId.value && send.status !== 'failed',
  );
  const active =
    canSend.value && !!conversation && suggestionsActive(messageId, conversation.messages, conversation.turns, sending);
  const busy =
    composerSendInFlight.value ||
    !!currentPendingEditor() ||
    isRecording.value ||
    !['idle', 'error'].includes(voice.state.value.phase);
  return { active, disabled: busy };
}

function location(): string {
  return JSON.stringify([groupId.value, threadId.value, channelType.value, messagingGroupId.value]);
}

export function replySuggestionControls(messageId: string) {
  const target = location();
  return {
    ...suggestionState(messageId),
    choose(text: string): void {
      const current = suggestionState(messageId);
      if (target !== location() || !current.active || current.disabled) return;
      const input = document.getElementById('chat-input');
      const result = fillSuggestedDraft(input instanceof HTMLTextAreaElement ? input : null, text);
      if (!result.filled) showToast(result.error, 'err');
    },
  };
}

export function bindInlineReplyControls(
  root: Pick<HTMLElement, 'querySelectorAll'>,
  controls: ReturnType<typeof replySuggestionControls>,
): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('button.inline-reply-suggestion[data-reply-draft]')) {
    button.disabled = controls.disabled;
    button.addEventListener('click', () => {
      const draft = button.dataset.replyDraft;
      if (draft) controls.choose(draft);
    });
  }
}

export function SuggestedResponses({ message }: { message: ChatMessage }) {
  const controls = replySuggestionControls(message.id);
  if (!controls.active) return null;
  return (
    <div class="reply-suggestions" aria-label="Suggested replies">
      {message.suggestedResponses?.map((text) => (
        <button
          type="button"
          class="message-action-btn"
          key={text}
          title={`Draft reply: ${text}`}
          disabled={controls.disabled}
          onClick={() => controls.choose(text)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
