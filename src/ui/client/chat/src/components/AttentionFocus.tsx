import { useEffect, useRef } from 'preact/hooks';
import {
  attentionSelection,
  attentionTargets,
  matchesAttentionLocation,
} from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId, chatReady } from '../state';
import { conversationState } from '../conversation-state';
import { activitySelection, activityNavigationPending, finishActivityNavigation } from '../activity-navigation';
import { showToast } from './Toast';
import { highlightMessage } from '../message-highlight';
import { attachJumpReadTracking } from '../read-state';

export function AttentionFocus() {
  const targets = attentionTargets.value;
  const activity = activitySelection.value;
  const pendingTarget = activityNavigationPending.value?.target;
  const selection = activity ?? attentionSelection.value;
  const handled = useRef<{ selection: typeof selection; stopRead?: () => void } | null>(null);
  const location = {
    agentGroupId: groupId.value,
    threadId: threadId.value,
    channelType: channelType.value,
    messagingGroupId: messagingGroupId.value,
  };
  const selected = activity
    ? { id: activity.target.anchor.id, origin: activity.target.origin, readCursor: activity.target.readCursor }
    : targets?.find((target) => target.id === attentionSelection.value?.id)
      ?? (pendingTarget && pendingTarget.anchor.id === attentionSelection.value?.id
        ? { id: pendingTarget.anchor.id, origin: pendingTarget.origin, readCursor: pendingTarget.readCursor }
        : undefined);
  const snapshot = conversationState.value;
  const ready = chatReady.value;
  const finish = () => {
    const pending = activityNavigationPending.peek();
    if (pending?.target && selected && pending.target.anchor.id === selected.id && matchesAttentionLocation({
      id: pending.target.anchor.id, origin: pending.target.origin,
    }, location)) finishActivityNavigation(pending.request);
  };
  useEffect(() => () => {
    if (handled.current?.selection === selection) {
      handled.current.stopRead?.();
      handled.current.stopRead = undefined;
    }
  }, [selection, location.agentGroupId, location.threadId, location.channelType, location.messagingGroupId]);
  useEffect(() => {
    if (
      !selection?.navigation ||
      !selected ||
      handled.current?.selection === selection ||
      !matchesAttentionLocation(selected, location)
    )
      return;
    const frame = requestAnimationFrame(() => {
      const target = activity
        ? document.querySelector<HTMLElement>(`#chat-log [data-msg-id="${CSS.escape(selected.id)}"]`)
        : document.getElementById(`attention-${selected.id}`);
      if (!target) {
        if ((activity || pendingTarget) && ready) {
          handled.current = { selection };
          console.warn('Activity source is no longer in the transcript', selected.id);
          showToast('This activity source is no longer available.', 'err', 5000, { transient: true });
          finish();
        }
        return;
      }
      handled.current?.stopRead?.();
      handled.current = { selection };
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      target.focus({ preventScroll: true });
      highlightMessage(target);
      finish();
      if (selected.readCursor && location.agentGroupId && location.threadId) {
        const log = target.closest<HTMLElement>('#chat-log');
        if (log) handled.current.stopRead = attachJumpReadTracking(log, target, {
          groupId: location.agentGroupId, threadId: location.threadId,
          channelType: location.channelType || 'web', messagingGroupId: location.messagingGroupId,
          cursor: selected.readCursor,
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    selection,
    selected,
    location.agentGroupId,
    location.threadId,
    location.channelType,
    location.messagingGroupId,
    snapshot,
    ready,
  ]);
  return null;
}
