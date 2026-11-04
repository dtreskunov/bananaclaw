import { useEffect, useRef } from 'preact/hooks';
import {
  attentionError,
  attentionPosition,
  attentionSelection,
  attentionTargets,
  matchesAttentionLocation,
} from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId } from '../state';
import { conversationState } from '../conversation-state';
import { navigateAttention } from '../actions';
import { AttentionBadge } from './AttentionBadge';

const DIRECTIONS = [
  { direction: -1, label: 'Previous input request', icon: '\u2039' },
  { direction: 1, label: 'Next input request', icon: '\u203A' },
] as const;

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
  const position = targets ? attentionPosition(targets, selection?.id ?? null, location) : -1;
  const disabled = !!error || count === 1;
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
      {DIRECTIONS.map(({ direction, label, icon }) => (
        <button
          key={direction}
          type="button"
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={() => {
            void navigateAttention(direction);
          }}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
