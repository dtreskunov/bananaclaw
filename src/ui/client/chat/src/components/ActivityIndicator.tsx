import './ActivityIndicator.css';
import { attentionError } from '../attention-state';
import type { ActivityStatus } from '../../../../shared/thread';

const labels = { idle: 'Idle', running: 'Running', waiting: 'Waiting' } as const;

export function activityDetails(status: ActivityStatus, requestCount = 0, subject?: string) {
  const stale = !!status.activityStale || !!attentionError.value;
  const label = labels[status.activity];
  let description = stale
    ? `Last known activity: ${label}. Live activity status is unavailable; waiting for updates.`
    : `Activity: ${label}`;
  if (status.activity === 'waiting' && subject) {
    const requests = `${requestCount} ${requestCount === 1 ? 'request' : 'requests'}`;
    description += stale
      ? ` ${requestCount} last known ${requestCount === 1 ? 'request' : 'requests'} in ${subject}.`
      : requestCount > 0
        ? `. ${requests} ${requestCount === 1 ? 'needs' : 'need'} your input. Open oldest request in ${subject}`
        : `. No actionable requests available in ${subject}.`;
  }
  return { stale, description, actionable: status.activity === 'waiting' && !stale && requestCount > 0 };
}

export function ActivityIndicator({ status, variant = 'label', description }: {
  status: ActivityStatus;
  variant?: 'dot' | 'label';
  description?: string;
}) {
  if (status.activity === 'idle') return null;
  const details = activityDetails(status);
  const label = description ?? details.description;
  return (
    <span
      class={`activity-indicator ${variant} ${status.activity}${details.stale ? ' stale' : ''}`}
      role="status"
      aria-live="off"
      aria-label={label}
      title={label}
    >
      {variant === 'label' ? status.activity : null}
    </span>
  );
}
