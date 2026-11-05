import './ThreadActivity.css';
import { attentionError } from '../attention-state';
import type { Thread } from '../types';

const labels = { idle: 'Idle', running: 'Running', waiting: 'Waiting' } as const;

export function ThreadActivity({ thread }: { thread: Thread }) {
  const stale = !!thread.activityStale || !!attentionError.value;
  const label = labels[thread.activity];
  const description = stale
    ? `Last known activity: ${label}. Live activity status is unavailable; waiting for updates.`
    : `Activity: ${label}`;
  return (
    <span
      class={`thread-activity ${thread.activity}${stale ? ' stale' : ''}`}
      role="status"
      aria-live="off"
      aria-label={description}
      title={description}
    >
      <span class="attention-separator" aria-hidden="true">{' \u00b7 '}</span>
      {thread.activity === 'running' ? <span class="thread-activity-dot" aria-hidden="true" /> : null}
      {label}{stale ? ' (last known)' : ''}
    </span>
  );
}
