import { describe, expect, it } from 'bun:test';
import { accumulateCallUsage, accumulateTurnUsage } from './usage.js';

const usage = {
  cost_usd: 1,
  input_tokens: 2,
  output_tokens: 3,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  model: 'm',
};

describe('model-call timing accumulation', () => {
  it('sums call and attempt timing without including wall-clock time', () => {
    const first = accumulateCallUsage(null, { ...usage, duration_api_ms: 100 });
    const second = accumulateCallUsage(first, { ...usage, duration_api_ms: 200 });
    expect(second).toMatchObject({ duration_api_ms: 300, num_turns: 2 });
    expect(accumulateTurnUsage(second, { ...usage, duration_api_ms: 50, duration_ms: 1000 })).toMatchObject({
      duration_api_ms: 350,
      duration_ms: 1000,
    });
  });

  it('preserves measured zero and never substitutes zero for unreported timing', () => {
    expect(accumulateCallUsage(null, { ...usage, duration_api_ms: 0 }).duration_api_ms).toBe(0);
    expect(accumulateCallUsage({ ...usage, duration_api_ms: 10 }, usage).duration_api_ms).toBeUndefined();
    expect(accumulateCallUsage(usage, { ...usage, duration_api_ms: 10 }).duration_api_ms).toBeUndefined();
  });
});
