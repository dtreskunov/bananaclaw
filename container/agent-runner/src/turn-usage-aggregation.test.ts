import { describe, it, expect } from 'bun:test';

import { callUsageFromInfo, sumOpenCodeUsage } from './providers/opencode';
import { lookupLimits } from './providers/model-catalog';
import { accumulateCallUsage, accumulateTurnUsage } from './providers/usage';

describe('usage accumulation', () => {
  const call = (input_tokens: number, context_tokens: number) => ({
    cost_usd: input_tokens / 1000,
    input_tokens,
    output_tokens: 2,
    cache_read_tokens: 3,
    cache_write_tokens: 4,
    reasoning_tokens: 5,
    model: 'm',
    context_tokens,
  });

  it('adds per-call billing while replacing context occupancy', () => {
    const first = accumulateCallUsage(null, call(10, 19));
    const second = accumulateCallUsage(first, call(20, 29));

    expect(second).toEqual({
      cost_usd: 0.03,
      input_tokens: 30,
      output_tokens: 4,
      cache_read_tokens: 6,
      cache_write_tokens: 8,
      reasoning_tokens: 10,
      num_turns: 2,
      model: 'm',
      context_tokens: 29,
    });
  });

  it('adds terminal attempt call counts for retry-safe final totals', () => {
    const total = accumulateTurnUsage(
      { ...call(10, 19), num_turns: 1 },
      { ...call(20, 29), num_turns: 2 },
    );
    expect(total.num_turns).toBe(3);
    expect(total.context_tokens).toBe(29);
  });
});

describe('lookupLimits', () => {
  const catalog = new Map([
    ['minimax/MiniMax-M3', { context: 1_000_000, output: 128_000 }],
    ['openrouter/minimax/minimax-m3', { context: 1_048_576, output: 512_000 }],
  ]);

  it('prefers an exact match', () => {
    expect(lookupLimits(catalog, 'minimax/MiniMax-M3')).toEqual({ context: 1_000_000, output: 128_000 });
  });

  // OpenRouter accepts the mixed-case id, so a group pinned that way runs but
  // used to record no limits at all.
  it('falls back to a case-insensitive match', () => {
    expect(lookupLimits(catalog, 'openrouter/minimax/MiniMax-M3')).toEqual({
      context: 1_048_576,
      output: 512_000,
    });
  });

  it('returns undefined for a model the catalog does not know', () => {
    expect(lookupLimits(catalog, 'openrouter/acme/nope')).toBeUndefined();
  });
});

describe('sumOpenCodeUsage', () => {
  // The bug this replaced: only the final assistant message was recorded, so a
  // tool-calling turn reported ~18% of what it actually cost.
  it('sums every assistant message in the turn', () => {
    const total = sumOpenCodeUsage([
      { cost_usd: 0.005775, input_tokens: 18626, output_tokens: 60, cache_read_tokens: 1920, cache_write_tokens: 0, model: 'MiniMax-M3' },
      { cost_usd: 0.00126138, input_tokens: 23, output_tokens: 15, cache_read_tokens: 20608, cache_write_tokens: 0, model: 'MiniMax-M3' },
    ]);
    expect(total).not.toBeNull();
    expect(total!.cost_usd).toBeCloseTo(0.00703638, 8);
    expect(total!.input_tokens).toBe(18649);
    expect(total!.output_tokens).toBe(75);
    expect(total!.cache_read_tokens).toBe(22528);
    expect(total!.model).toBe('MiniMax-M3');
    expect(total!.num_turns).toBe(2);
  });

  it('skips messages with no usage snapshot', () => {
    const total = sumOpenCodeUsage([
      undefined,
      { cost_usd: 1, input_tokens: 2, output_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5, reasoning_tokens: 6, model: 'm' },
    ]);
    expect(total!.input_tokens).toBe(2);
    expect(total!.reasoning_tokens).toBe(6);
  });

  it('returns null when the turn produced no usage at all', () => {
    expect(sumOpenCodeUsage([])).toBeNull();
    expect(sumOpenCodeUsage([undefined, undefined])).toBeNull();
  });

  // Every round trip resends the conversation, so the summed counts run far
  // past the window. Occupancy is the last round trip on its own.
  it('reports context occupancy from the last round trip, not the sum', () => {
    const total = sumOpenCodeUsage([
      callUsageFromInfo({ cost: 0, tokens: { input: 18626, output: 60, cache: { read: 1920, write: 0 } }, modelID: 'm' }),
      callUsageFromInfo({ cost: 0, tokens: { input: 23, output: 15, cache: { read: 20608, write: 0 } }, modelID: 'm' }),
    ]);
    expect(total!.context_tokens).toBe(23 + 20608 + 15);
    expect(total!.input_tokens + total!.cache_read_tokens).toBeGreaterThan(total!.context_tokens!);
  });
});
