import { afterEach, describe, expect, it } from 'vitest';
import {
  activityTraceView,
  followActivityTrace,
  inheritActivityTrace,
  pauseActivityTrace,
  resetActivityTraceView,
  toggleActivityTrace,
} from './activity-trace-state';

afterEach(resetActivityTraceView);

describe('activity trace follow intent', () => {
  it('enables following without collapsing an already expanded count-only trace', () => {
    toggleActivityTrace('turn:first');
    expect(activityTraceView('turn:first', true)).toEqual({ expanded: true, following: false });
    followActivityTrace('turn:first');
    expect(activityTraceView('turn:first', true)).toEqual({ expanded: true, following: true });
  });

  it('does not let callbacks from an old trace steal the current expansion', () => {
    toggleActivityTrace('turn:current', true);
    followActivityTrace('turn:old');
    pauseActivityTrace('turn:old');
    expect(activityTraceView('turn:current', true)).toEqual({ expanded: true, following: true });
    expect(activityTraceView('turn:old', true)).toEqual({ expanded: false, following: false });
  });

  it('retains intent after settlement and transfers it to exactly one new owner', () => {
    toggleActivityTrace('turn:first', true);
    expect(activityTraceView('turn:first')).toEqual({ expanded: true, following: false });
    inheritActivityTrace('turn:next');
    expect(activityTraceView('turn:first')).toEqual({ expanded: false, following: false });
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: true, following: true });
    inheritActivityTrace('turn:next');
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: true, following: true });
  });

  it.each(['browse', 'collapse', 'reset'] as const)('does not inherit after %s', (action) => {
    toggleActivityTrace('turn:first', true);
    if (action === 'browse') pauseActivityTrace('turn:first');
    else if (action === 'collapse') toggleActivityTrace('turn:first');
    else resetActivityTraceView();
    inheritActivityTrace('turn:next');
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: false, following: false });
    expect(activityTraceView('turn:first', true).expanded).toBe(action === 'browse');
  });

  it('does not inherit a count-only expansion or invent follow intent', () => {
    inheritActivityTrace('turn:first');
    expect(activityTraceView('turn:first', true).expanded).toBe(false);
    toggleActivityTrace('turn:first');
    inheritActivityTrace('turn:next');
    expect(activityTraceView('turn:first', true)).toEqual({ expanded: true, following: false });
    expect(activityTraceView('turn:next', true).expanded).toBe(false);
  });
});
