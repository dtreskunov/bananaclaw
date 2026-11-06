// Self-refreshing relative timestamp.
import { nowTick } from '../state';
import { fmtRelative, fmtAbsolute } from '../utils';
import type { EpochMs } from '../../../../shared/time';

interface Props {
  ts: EpochMs | null | undefined;
  className?: string;
}

export function RelativeTime({ ts, className }: Props) {
  // Subscribe to the tick so signals re-renders us.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  nowTick.value;
  if (ts == null) return null;
  return <span class={className || 'ts'} title={fmtAbsolute(ts)}>{fmtRelative(ts)}</span>;
}
