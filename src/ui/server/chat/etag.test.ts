import { describe, it, expect } from 'vitest';
import { parseIfMatch, ifMatchSatisfied } from './etag.js';

describe('parseIfMatch', () => {
  it('returns null when no header is supplied', () => {
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('')).toBeNull();
    expect(parseIfMatch('   ')).toBeNull();
  });

  it('returns the wildcard for *', () => {
    expect(parseIfMatch('*')).toBe('*');
  });

  it('splits a comma-separated list and trims entries', () => {
    expect(parseIfMatch('"a", "b" ,"c"')).toEqual(['"a"', '"b"', '"c"']);
  });

  it('joins an array header before parsing', () => {
    expect(parseIfMatch(['"a"', '"b"'])).toEqual(['"a"', '"b"']);
  });
});

describe('ifMatchSatisfied', () => {
  it('returns null when no precondition is supplied', () => {
    expect(ifMatchSatisfied(undefined, '"a"')).toBeNull();
  });

  it('wildcard matches iff the resource exists', () => {
    expect(ifMatchSatisfied('*', '"a"')).toBe(true);
    expect(ifMatchSatisfied('*', null)).toBe(false);
  });

  it('matches an exact strong tag', () => {
    expect(ifMatchSatisfied('"abc"', '"abc"')).toBe(true);
    expect(ifMatchSatisfied('"abc"', '"xyz"')).toBe(false);
  });

  it('is false when the resource is gone', () => {
    expect(ifMatchSatisfied('"abc"', null)).toBe(false);
  });

  it('matches when a proxy weakened the echoed tag (W/ prefix on client side)', () => {
    expect(ifMatchSatisfied('W/"abc"', '"abc"')).toBe(true);
  });

  it('matches when the current tag is weak but the client sent strong', () => {
    expect(ifMatchSatisfied('"abc"', 'W/"abc"')).toBe(true);
  });

  it('matches within a mixed weak/strong list', () => {
    expect(ifMatchSatisfied('"nope", W/"abc"', '"abc"')).toBe(true);
  });
});
