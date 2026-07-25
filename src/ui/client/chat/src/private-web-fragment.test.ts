import { describe, expect, it } from 'vitest';
import { forwardedFragment } from './private-web-fragment';

describe('forwardedFragment', () => {
  it('returns empty string for absent or empty fragments', () => {
    expect(forwardedFragment(undefined)).toBe('');
    expect(forwardedFragment(null)).toBe('');
    expect(forwardedFragment('')).toBe('');
    expect(forwardedFragment('#')).toBe('');
  });

  it('preserves an encoded deep-link fragment', () => {
    const hash = '#url=https%3A%2F%2Fwww.nytimes.com%2F&title=The%20New%20York%20Times&t=1784933160536';
    expect(forwardedFragment(hash)).toBe(hash);
  });

  it('adds a leading hash when the caller omits it', () => {
    expect(forwardedFragment('url=x')).toBe('#url=x');
  });

  it('strips control characters that could break the iframe URL', () => {
    expect(forwardedFragment('#url=x\ny=2\u0000')).toBe('#url=xy=2');
  });
});
