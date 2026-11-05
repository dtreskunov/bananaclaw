import './ActivityIndicator.css';
import { attentionError } from '../attention-state';
import type { ActivityStatus } from '../../../../shared/thread';

const labels = { idle: 'Idle', running: 'Running' } as const;

export function activityDetails(status: ActivityStatus, requestCount = 0, subject?: string) {
  const stale = !!status.activityStale || !!attentionError.value;
  const label = labels[status.activity];
  let description = stale
    ? `Last known activity: ${label}. Live activity status is unavailable; waiting for updates`
    : `Activity: ${label}`;
  if (status.waiting) description += '. Waiting for input';
  if (status.waiting && subject) {
    const requests = `${requestCount} ${requestCount === 1 ? 'request' : 'requests'}`;
    description += attentionError.value
      ? ` ${requestCount} last known ${requestCount === 1 ? 'request' : 'requests'} in ${subject}.`
      : requestCount > 0
        ? `. ${requests} ${requestCount === 1 ? 'needs' : 'need'} your input. Open oldest request in ${subject}`
        : `. No actionable requests available in ${subject}.`;
  }
  return { stale, description, actionable: !!status.waiting && !attentionError.value && requestCount > 0 };
}

export function ActivityIndicator({ status, description }: {
  status: ActivityStatus;
  description?: string;
}) {
  const details = activityDetails(status);
  const label = description ?? details.description;
  return (
    <span
      class={`activity-indicator ${status.activity}${status.waiting ? ' waiting' : ''}${details.stale ? ' stale' : ''}`}
      role="status"
      aria-live="off"
      aria-label={label}
      title={label}
    >
      <span class="activity-indicator-base" aria-hidden="true" />
      {status.waiting ? <span class="activity-indicator-question" aria-hidden="true">?</span> : null}
    </span>
  );
}
