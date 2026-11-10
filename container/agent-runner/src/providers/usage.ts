import type { CallUsage, TurnUsage, TurnUsageAdvisory } from './types.js';

export function combineCostSources(
  previous: TurnUsage['cost_source'],
  next: TurnUsage['cost_source'],
): TurnUsage['cost_source'] {
  if (previous === 'unavailable' || next === 'unavailable') return 'unavailable';
  if (previous === next) return next;
  if (!previous || !next) return undefined;
  return 'mixed';
}

export function transitionUsageAdvisory(
  advisory: TurnUsageAdvisory | undefined,
  status: 'applied' | 'skipped',
  timestamp: number,
): TurnUsageAdvisory | undefined {
  if (advisory?.status !== 'queued') return advisory;
  return { ...advisory, status,
    appliedAt: status === 'applied' ? timestamp : null,
    finishedAt: status === 'skipped' ? timestamp : null };
}

export function reportedTokenTotal(...buckets: unknown[]): number | undefined {
  if (!buckets.every((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
    return undefined;
  const total = buckets.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

/** Add one complete turn/attempt total to a prior total. Billing fields and
 * call counts add; context occupancy and other metadata come from the newest
 * value that reports them. */
export function accumulateTurnUsage(total: TurnUsage | null, next: TurnUsage): TurnUsage {
  if (!total) return { ...next };
  return {
    ...next,
    reported_tokens: reportedTokenTotal(total.reported_tokens, next.reported_tokens),
    cost_source: combineCostSources(total.cost_source, next.cost_source),
    model: next.model || total.model,
    cost_usd: total.cost_usd + next.cost_usd,
    input_tokens: total.input_tokens + next.input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    cache_read_tokens: total.cache_read_tokens + next.cache_read_tokens,
    cache_write_tokens: total.cache_write_tokens + next.cache_write_tokens,
    reasoning_tokens: (total.reasoning_tokens ?? 0) + (next.reasoning_tokens ?? 0),
    num_turns: (total.num_turns ?? 0) + (next.num_turns ?? 0) || undefined,
    duration_api_ms: total.duration_api_ms !== undefined && next.duration_api_ms !== undefined
      ? total.duration_api_ms + next.duration_api_ms
      : undefined,
    context_tokens: next.context_tokens ?? total.context_tokens,
  };
}

/** Add one provider call to the current in-flight turn snapshot. */
export function accumulateCallUsage(total: TurnUsage | null, next: CallUsage): TurnUsage {
  return accumulateTurnUsage(total, { ...next, num_turns: 1 });
}