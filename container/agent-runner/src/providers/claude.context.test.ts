import { describe, it, expect } from 'bun:test';
import { claudeContextTokens } from './claude.js';

describe('claudeContextTokens', () => {
  // The whole prompt is resident regardless of how it was billed, so a cached
  // turn occupies just as much window as an uncached one.
  it('counts cache reads and writes as resident, not just fresh input', () => {
    expect(
      claudeContextTokens({
        input_tokens: 12,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 1_500,
        output_tokens: 300,
      }),
    ).toBe(21_812);
  });

  it('tolerates a partial usage object', () => {
    expect(claudeContextTokens({ input_tokens: 40 })).toBe(40);
  });

  // Absent, not zero: a blank figure renders no percentage, where a zero would
  // claim the context is empty.
  it('reports nothing when the message carried no usage', () => {
    expect(claudeContextTokens(undefined)).toBeUndefined();
    expect(claudeContextTokens({})).toBeUndefined();
    expect(claudeContextTokens({ input_tokens: 0, output_tokens: 0 })).toBeUndefined();
  });
});
