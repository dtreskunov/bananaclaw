import { isEpochMs, type EpochMs } from '../../../shared/time';

export function fmtNextRun(timestamp: EpochMs): string {
  const diff = timestamp - Date.now();
  if (diff <= 30_000) return 'now';
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `in ${day}d`;
  return new Date(timestamp).toLocaleDateString();
}

export function toDatetimeLocal(timestamp: EpochMs | null): string {
  const date = new Date(timestamp ?? Date.now());
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

/** Only datetime-local input is parsed in the browser; API timestamps are already instants. */
export function fromDatetimeLocal(value: string, original: EpochMs | null = null): EpochMs | null {
  if (original !== null && value === toDatetimeLocal(original)) return original;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) return null;
  const timestamp = new Date(value).getTime();
  if (!isEpochMs(timestamp)) return null;
  // Reject calendar overflow and local times skipped by a daylight-saving transition.
  if (toDatetimeLocal(timestamp).slice(0, value.length) !== value) return null;
  return timestamp;
}
