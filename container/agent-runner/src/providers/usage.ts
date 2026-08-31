import type { CallUsage, TurnUsage } from './types.js';

/** Add one complete turn/attempt total to a prior total. Billing fields and
 * call counts add; context occupancy and other metadata come from the newest
 * value that reports them. */
export function accumulateTurnUsage(total: TurnUsage | null, next: TurnUsage): TurnUsage {
  if (!total) return { ...next };
  return {
    ...next,
    cost_usd: total.cost_usd + next.cost_usd,
    input_tokens: total.input_tokens + next.input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    cache_read_tokens: total.cache_read_tokens + next.cache_read_tokens,
    cache_write_tokens: total.cache_write_tokens + next.cache_write_tokens,
    reasoning_tokens: (total.reasoning_tokens ?? 0) + (next.reasoning_tokens ?? 0),
    num_turns: (total.num_turns ?? 0) + (next.num_turns ?? 0) || undefined,
    context_tokens: next.context_tokens ?? total.context_tokens,
  };
}

/** Add one provider call to the current in-flight turn snapshot. */
export function accumulateCallUsage(total: TurnUsage | null, next: CallUsage): TurnUsage {
  return accumulateTurnUsage(total, { ...next, num_turns: 1 });
}