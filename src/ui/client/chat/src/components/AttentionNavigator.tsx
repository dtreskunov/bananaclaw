import { useEffect, useRef } from 'preact/hooks';
import {
  attentionError,
  attentionSelection,
  attentionTargets,
  matchesAttentionLocation,
} from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId } from '../state';
import { conversationState } from '../conversation-state';
import { navigateAttention } from '../actions';
import { AttentionBadge } from './AttentionBadge';

export function AttentionNavigator() {
  const targets = attentionTargets.value;
  const error = attentionError.value;
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
  const count = targets?.length;
  if (!count && !error) return null;
  const title = error
    ? `Input status unavailable: ${error}. Showing last known requests.`
    : `${count} requests need your input. Open next newest request.`;
  return (
    <button
      type="button"
      class="attention-navigation"
      data-stale={error ? 'true' : undefined}
      aria-label={
        error
          ? `Input request status unavailable. ${count ?? 'Unknown'} last known requests.`
          : `${count} requests need your input. Open next newest request.`
      }
      title={title}
      disabled={!!error || !count}
      onClick={() => { void navigateAttention(); }}
    >
      <AttentionBadge
        value={count ?? '?'}
        label={count === undefined ? 'Input request count unavailable' : `${count} requests need your input`}
      />
    </button>
  );
}
