import { signal } from '@preact/signals';
import { render } from 'preact';
import { suggestionsActive, fillSuggestedDraft, isReplyLabel } from '../reply-suggestions';
import { conversationState } from '../conversation-state';
import { canSend, channelType, chatReady, groupId, messagingGroupId, pendingWebSends, threadId } from '../state';
import { sendChat } from '../actions';
import { composerSendInFlight, currentPendingEditor } from '../pending-edit';
import { isRecording } from '../recorder';
import { voice } from '../voice-audio';
import { showToast } from './Toast';
import { ReplySuggestion } from './ReplySuggestion';

const sendingSuggestions = signal(new Set<string>());

function suggestionState(messageId: string) {
  const conversation = conversationState.value?.conversation;
  const sending = pendingWebSends.value.some(
    (send) => send.groupId === groupId.value && send.threadId === threadId.value && send.status !== 'failed',
  );
  const active =
    canSend.value && !!conversation && suggestionsActive(messageId, conversation.messages, conversation.turns, sending);
  const busy =
    composerSendInFlight.value ||
    sendingSuggestions.value.has(location()) ||
    !!currentPendingEditor() ||
    isRecording.value ||
    !['idle', 'error'].includes(voice.state.value.phase);
  const isWeb = !channelType.value || channelType.value === 'web';
  return { active, disabled: busy, sendDisabled: busy || (isWeb && !chatReady.value) };
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
      const result = fillSuggestedDraft(input instanceof HTMLTextAreaElement ? input : null, text, target);
      if (!result.filled) showToast(result.error);
    },
    async send(text: string): Promise<boolean> {
      const current = suggestionState(messageId);
      if (target !== location() || !current.active || current.sendDisabled) return false;
      sendingSuggestions.value = new Set(sendingSuggestions.value).add(target);
      try {
        return await sendChat(text, []);
      } catch (error) {
        console.error('Failed to send suggested reply', error);
        if (target === location()) showToast('Could not send this suggestion. Your draft is unchanged.', 'err');
        return false;
      } finally {
        const remaining = new Set(sendingSuggestions.value);
        remaining.delete(target);
        sendingSuggestions.value = remaining;
      }
    },
  };
}

export function mountInlineReplySuggestions(
  root: Pick<HTMLElement, 'querySelectorAll'>,
  controls: ReturnType<typeof replySuggestionControls>,
): () => void {
  const mounted: HTMLElement[] = [];
  if (controls.active) {
    for (const slot of root.querySelectorAll<HTMLElement>('span.inline-reply-slot')) {
      const label = slot.textContent || '';
      if (!isReplyLabel(label)) continue;
      const labelHtml = slot.innerHTML;
      slot.replaceChildren();
      render(
        <ReplySuggestion
          label={label}
          labelHtml={labelHtml}
          disabled={controls.disabled}
          sendDisabled={controls.sendDisabled}
          onChoose={controls.choose}
          onSend={(text) => {
            void controls.send(text);
          }}
        />,
        slot,
      );
      mounted.push(slot);
    }
  }
  return () => {
    for (const slot of mounted) render(null, slot);
  };
}
