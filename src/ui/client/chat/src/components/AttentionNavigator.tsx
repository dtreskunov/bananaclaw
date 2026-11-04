import { useEffect, useRef } from 'preact/hooks';
import {
  attentionError,
  attentionPosition,
  attentionSelection,
  attentionTargets,
  matchesAttentionLocation,
} from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId, pendingApprovals, pendingQuestions } from '../state';
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
  const revision = conversationState.value?.revision;
  const approvals = pendingApprovals.value;
  const questions = pendingQuestions.value;
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
    revision,
    approvals,
    questions,
  ]);
  if ((!targets || targets.length === 0) && !error) return null;
  const count = targets?.length;
  const position = targets ? attentionPosition(targets, selection?.id ?? null, location) : -1;
  const disabled = !!error || count === undefined || count < 2;
  const title = error
    ? `Input status unavailable: ${error}. Showing last known requests.`
    : 'Requests needing your input';
  return (
    <div
      class="attention-navigation"
      data-stale={error ? 'true' : undefined}
      role="group"
      aria-label={
        error
          ? `Input request status unavailable. ${count ?? 'Unknown'} last known requests.`
          : 'Requests needing your input'
      }
      title={title}
    >
      <AttentionBadge value={position < 0 ? '\u2014' : position + 1} neutral label="Current request position" />
      <span aria-hidden="true">of</span>
      <button
        type="button"
        class="attention-open"
        aria-label="Open input request"
        title={title}
        disabled={!!error || !count}
        onClick={() => {
          void navigateAttention(0);
        }}
      >
        <AttentionBadge
          value={count ?? '?'}
          label={count === undefined ? 'Input request count unavailable' : `${count} requests need your input`}
        />
      </button>
      <button
        type="button"
        aria-label="Previous input request"
        title="Previous input request"
        disabled={disabled}
        onClick={() => {
          void navigateAttention(-1);
        }}
      >
        {'\u2039'}
      </button>
      <button
        type="button"
        aria-label="Next input request"
        title="Next input request"
        disabled={disabled}
        onClick={() => {
          void navigateAttention(1);
        }}
      >
        {'\u203A'}
      </button>
    </div>
  );
}
