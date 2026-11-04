import { useEffect, useRef } from 'preact/hooks';
import {
  attentionSelection,
  attentionTargets,
  matchesAttentionLocation,
} from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId } from '../state';
import { conversationState } from '../conversation-state';

export function AttentionFocus() {
  const targets = attentionTargets.value;
  const selection = attentionSelection.value;
  const handled = useRef<number | null>(null);
  const location = {
    agentGroupId: groupId.value,
    threadId: threadId.value,
    channelType: channelType.value,
    messagingGroupId: messagingGroupId.value,
  };
  const selected = targets?.find((target) => target.id === selection?.id);
  const snapshot = conversationState.value;
  useEffect(() => {
    if (
      !selection?.navigation ||
      !selected ||
      handled.current === selection.navigation ||
      !matchesAttentionLocation(selected, location)
    )
      return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`attention-${selection.id}`);
      if (!target) return;
      handled.current = selection.navigation;
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      target.focus({ preventScroll: true });
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
  ]);
  return null;
}
