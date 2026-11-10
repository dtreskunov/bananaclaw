import { describe, expect, it } from 'bun:test';
import { accumulateCallUsage, accumulateTurnUsage, reportedTokenTotal, combineCostSources, transitionUsageAdvisory } from './usage.js';
import type { TurnUsage, TurnUsageAdvisory } from './types.js';

const usage = {
  cost_usd: 1,
  input_tokens: 2,
  output_tokens: 3,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  model: 'm',
};

describe('model-call timing accumulation', () => {
  it('handles all cost provenance combinations symmetrically without hiding missing information', () => {
    const sources: TurnUsage['cost_source'][] = [undefined, 'reported', 'estimated', 'mixed', 'unavailable'];
    for (const previous of sources) for (const next of sources) {
      const actual = combineCostSources(previous, next);
      expect(actual).toBe(combineCostSources(next, previous));
      if (previous === 'unavailable' || next === 'unavailable') expect(actual).toBe('unavailable');
      else if (previous === next) expect(actual).toBe(next);
      else if (!previous || !next) expect(actual).toBeUndefined();
      else expect(actual).toBe('mixed');
    }
  });

  it('transitions queued guidance once without mutating its prior snapshot', () => {
    const queued: TurnUsageAdvisory = { threshold: 10, reportedTokens: 10, triggeredAt: 1,
      status: 'queued', appliedAt: null, finishedAt: null };
    for (const status of ['applied', 'skipped'] as const) {
      const finished = transitionUsageAdvisory(queued, status, 2);
      expect(finished).toEqual({ ...queued, status, appliedAt: status === 'applied' ? 2 : null,
        finishedAt: status === 'skipped' ? 2 : null });
      expect(transitionUsageAdvisory(finished, 'skipped', 3)).toBe(finished);
      expect(queued.status).toBe('queued');
    }
    expect(transitionUsageAdvisory(undefined, 'skipped', 2)).toBeUndefined();
  });
  it('distinguishes measured zero from missing, invalid and overflowing buckets', () => {
    expect(reportedTokenTotal(0, 0, 0, 0)).toBe(0);
    for (const invalid of [undefined, null, NaN, -1, 0.5, '1', Infinity])
      expect(reportedTokenTotal(1, invalid)).toBeUndefined();
    expect(reportedTokenTotal(Number.MAX_SAFE_INTEGER, 1)).toBeUndefined();
  });
  it('sums normalized reported processing without adding reasoning twice', () => {
    const first = accumulateCallUsage(null, { ...usage, reported_tokens: 5, reasoning_tokens: 2 });
    expect(accumulateCallUsage(first, { ...usage, reported_tokens: 5, reasoning_tokens: 2 }))
      .toMatchObject({ reported_tokens: 10, reasoning_tokens: 4, output_tokens: 6, num_turns: 2 });
    expect(accumulateCallUsage(first, usage).reported_tokens).toBeUndefined();
    expect(accumulateCallUsage(null, { ...usage, reported_tokens: 0 }).reported_tokens).toBe(0);
  });

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
