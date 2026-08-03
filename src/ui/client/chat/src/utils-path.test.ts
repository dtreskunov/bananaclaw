import { describe, expect, it } from 'vitest';
import { pathBelowRoot } from './utils';

describe('pathBelowRoot', () => {
  it('strips the search root from result paths', () => {
    expect(pathBelowRoot('docs/retirement-destination', 'docs/retirement-destination')).toBe('');
    expect(pathBelowRoot('docs/retirement-destination/photos', 'docs/retirement-destination')).toBe('/photos');
  });

  it('does not strip partial path-segment matches', () => {
    expect(pathBelowRoot('docs/archive', 'doc')).toBe('/docs/archive');
  });

  it('keeps root searches workspace-relative', () => {
    expect(pathBelowRoot('docs/archive', '')).toBe('/docs/archive');
  });
});
