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
        ? `. ${requests} ${requestCount === 1 ? 'needs' : 'need'} your input. Open newest request in ${subject}`
        : `. No actionable requests available in ${subject}.`;
  }
  return { stale, description, actionable: !!status.waiting && !attentionError.value && requestCount > 0 };
}

export function activityNavigationDetails(status: ActivityStatus, unread: boolean, requestCount: number, subject: string) {
  const details = activityDetails(status, requestCount, subject);
  const description = `${unread ? 'Unread. ' : ''}${details.description}`;
  if (status.waiting) return { ...details, description };
  const source = unread ? 'unread message' : status.activity === 'running' ? 'originating message' : 'message';
  return { ...details, actionable: true, description: `${description}. Open newest ${source} in ${subject}` };
}

export function ActivityIndicator({ status, description, unread = false, navigating = false }: {
  status: ActivityStatus;
  description?: string;
  unread?: boolean;
  navigating?: boolean;
}) {
  const details = activityDetails(status);
  const label = description ?? `${unread ? 'Unread. ' : ''}${details.description}`;
  return (
    <span
      class={`activity-indicator ${status.activity}${status.waiting ? ' waiting' : ''}${unread ? ' unread' : ''}${details.stale ? ' stale' : ''}`}
      role="status"
      aria-live={navigating ? 'polite' : 'off'}
      aria-busy={navigating || undefined}
      aria-label={label}
      title={label}
    >
      <span class="activity-indicator-base" aria-hidden="true" />
      {status.waiting || unread ? <span class="activity-indicator-dot" aria-hidden="true" /> : null}
    </span>
  );
}
