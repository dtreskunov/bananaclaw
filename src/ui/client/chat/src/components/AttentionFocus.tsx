import { useEffect, useRef } from 'preact/hooks';
import { matchesAttentionLocation } from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId, chatReady } from '../state';
import { conversationState } from '../conversation-state';
import { activitySelection, finishActivityNavigation, isCurrentActivityNavigation } from '../activity-navigation';
import { showToast } from './Toast';
import { highlightMessage } from '../message-highlight';
import { attachJumpReadTracking } from '../read-state';

export function AttentionFocus() {
  const selection = activitySelection.value;
  const handled = useRef<{ selection: typeof selection; stopRead?: () => void } | null>(null);
  const location = {
    agentGroupId: groupId.value,
    threadId: threadId.value,
    channelType: channelType.value,
    messagingGroupId: messagingGroupId.value,
  };
  const selected = selection?.target;
  const snapshot = conversationState.value;
  const ready = chatReady.value;
  useEffect(
    () => () => {
      if (handled.current?.selection === selection) {
        handled.current.stopRead?.();
        handled.current.stopRead = undefined;
      }
    },
    [selection, location.agentGroupId, location.threadId, location.channelType, location.messagingGroupId],
  );
  useEffect(() => {
    if (
      !selection ||
      !selected ||
      handled.current?.selection === selection ||
      !matchesAttentionLocation(selected, location)
    )
      return;
    const frame = requestAnimationFrame(() => {
      if (!isCurrentActivityNavigation(selection.request)) return;
      const target = document.querySelector<HTMLElement>(`#chat-log [data-msg-id="${CSS.escape(selected.anchor.id)}"]`);
      if (!target) {
        if (ready) {
          handled.current = { selection };
          console.warn('Activity source is no longer in the transcript', selected.anchor.id);
          showToast('This activity source is no longer available.', 'err', 5000, { transient: true });
          finishActivityNavigation(selection.request);
        }
        return;
      }
      handled.current?.stopRead?.();
      handled.current = { selection };
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      target.focus({ preventScroll: true });
      highlightMessage(target);
      finishActivityNavigation(selection.request);
      if (selected.readCursor && location.agentGroupId && location.threadId) {
        const log = target.closest<HTMLElement>('#chat-log');
        if (log)
          handled.current.stopRead = attachJumpReadTracking(log, target, {
            groupId: location.agentGroupId,
            threadId: location.threadId,
            channelType: location.channelType || 'web',
            messagingGroupId: location.messagingGroupId,
            cursor: selected.readCursor,
          });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    selection,
    location.agentGroupId,
    location.threadId,
    location.channelType,
    location.messagingGroupId,
    snapshot,
    ready,
  ]);
  return null;
}
