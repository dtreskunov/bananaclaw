import { describe, expect, it } from 'vitest';
import { technicalSummary } from './technical-summary';

describe('compact technical summary', () => {
  it('matches the requested shape without model, token or model-call counts', () => {
    const value = {
      elapsedMs: 15_000,
      usage: [
        {
          cost_usd: 2.09,
          context_tokens: 70_000,
          context_window: 200_000,
          model: 'MiniMax-M3',
          input_tokens: 798_800,
          num_turns: 5,
        },
      ],
    };
    const before = JSON.stringify(value);
    expect(technicalSummary(value)).toBe('15s · $2.09 · 35% ctx');
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    { elapsedMs: null, usage: [], expected: '' },
    { elapsedMs: 15_000, usage: [], expected: '15s' },
    { elapsedMs: null, usage: [{ model: 'model', input_tokens: 12, num_turns: 5 }], expected: '' },
    {
      elapsedMs: 0,
      usage: [{ cost_usd: 0, context_tokens: 0, context_window: 200 }],
      expected: '0ms · 0% ctx',
    },
    { elapsedMs: null, usage: [{ cost_usd: 2.09 }], expected: '$2.09' },
    { elapsedMs: null, usage: [{ context_tokens: 1, context_window: 1000 }], expected: '<1% ctx' },
  ])('omits absent fields without stray separators ($expected)', ({ expected, ...value }) => {
    expect(technicalSummary(value)).toBe(expected);
  });

  it.each([
    { elapsedMs: 500, expected: '500ms' },
    { elapsedMs: 59_000, expected: '59s' },
    { elapsedMs: 59_999, expected: '1m 0s' },
    { elapsedMs: 60_000, expected: '1m 0s' },
    { elapsedMs: 710_000, expected: '11m 50s' },
    { elapsedMs: 710_999, expected: '11m 51s' },
    { elapsedMs: 3_661_000, expected: '61m 1s' },
  ])('formats elapsed time as $expected', ({ elapsedMs, expected }) => {
    expect(technicalSummary({ elapsedMs, usage: [] })).toBe(expected);
  });

  it('omits zero cost across reports, without hiding small positive costs', () => {
    expect(technicalSummary({ elapsedMs: null, usage: [{ cost_usd: 0 }] })).toBe('');
    expect(technicalSummary({ elapsedMs: 710_000, usage: [{ cost_usd: 0 }, { cost_usd: 0 }] })).toBe('11m 50s');
    expect(technicalSummary({ elapsedMs: 710_000, usage: [{ cost_usd: 0 }, { cost_usd: 2.09 }] })).toBe(
      '11m 50s · $2.09',
    );
    expect(technicalSummary({ elapsedMs: null, usage: [{ cost_usd: 0.0001 }] })).toBe('$0.0001');
  });

  it('totals known costs across reports and uses the latest context rather than summing context', () => {
    expect(
      technicalSummary({
        elapsedMs: 15_000,
        usage: [
          { cost_usd: 1, context_tokens: 150, context_window: 200 },
          { cost_usd: 1.09, context_tokens: 70, context_window: 200 },
        ],
      }),
    ).toBe('15s · $2.09 · 35% ctx');
  });

  it('does not invent a complete cost total or a missing context window', () => {
    expect(
      technicalSummary({
        elapsedMs: null,
        usage: [{ cost_usd: 1 }, { input_tokens: 1, context_tokens: 100 }],
      }),
    ).toBe('');
    expect(technicalSummary({ elapsedMs: null, usage: [{ context_tokens: 201, context_window: 200 }] })).toBe('');
    expect(technicalSummary({ elapsedMs: null, usage: [{ context_tokens: 1, context_window: 0 }] })).toBe('');
  });
});
