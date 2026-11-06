import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtAbsolute, fmtRelative, sortGroups } from './utils';

afterEach(() => vi.restoreAllMocks());

describe('epoch millisecond presentation', () => {
  it('subtracts numeric timestamps directly, including epoch zero', () => {
    vi.spyOn(Date, 'now').mockReturnValue(120_000);
    vi.spyOn(Date, 'parse').mockImplementation(() => {
      throw new Error('No timestamp parsing in presentation');
    });
    vi.spyOn(String.prototype, 'includes').mockImplementation(() => {
      throw new Error('No string normalization');
    });
    expect(fmtRelative(0)).toBe('2m');
    expect(fmtRelative(120_000)).toBe('just now');
    expect(fmtRelative(240_000)).toBe('just now');
    expect(fmtAbsolute(0)).toBe(new Date(0).toLocaleString());
  });

  it.each([null, undefined])('does not invent dates for missing time %j', (timestamp) => {
    expect(fmtRelative(timestamp)).toBe('');
    expect(fmtAbsolute(timestamp)).toBe('');
  });

  it('sorts numeric group times without mutating input and preserves name ties', () => {
    const groups = [
      { id: 'later', name: 'Later', lastActivityAt: 11 },
      { id: 'ten', name: 'Ten', lastActivityAt: 10 },
      { id: 'zero', name: 'Zero', lastActivityAt: 0 },
      { id: 'empty', name: 'Empty', lastActivityAt: null },
    ];
    vi.spyOn(Date, 'parse').mockImplementation(() => {
      throw new Error('No normalization');
    });
    expect(sortGroups(groups).map(({ id }) => id)).toEqual(['later', 'ten', 'empty', 'zero']);
    expect(groups.map(({ id }) => id)).toEqual(['later', 'ten', 'zero', 'empty']);
  });
});
