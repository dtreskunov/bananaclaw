import { afterEach, describe, expect, it } from 'vitest';
import {
  activityTraceView,
  activityTraceFollowing,
  followActivityTrace,
  inheritActivityTrace,
  pauseActivityTrace,
  resetActivityTraceView,
  toggleActivityTrace,
  activityMetricsExpanded,
  toggleActivityMetrics,
} from './activity-trace-state';

afterEach(resetActivityTraceView);

describe('activity metrics disclosure', () => {
  it('is independent of trace expansion and following', () => {
    toggleActivityMetrics('turn:first');
    expect(activityMetricsExpanded('turn:first')).toBe(true);
    expect(activityTraceView('turn:first', true).expanded).toBe(false);
    toggleActivityTrace('turn:first', true);
    toggleActivityMetrics('turn:first');
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityTraceView('turn:first', true)).toEqual({ expanded: true, following: true });
    toggleActivityMetrics('turn:first');
    toggleActivityTrace('turn:first');
    expect(activityMetricsExpanded('turn:first')).toBe(true);
  });

  it('retains each turn selection until conversation navigation resets it', () => {
    toggleActivityMetrics('turn:first');
    inheritActivityTrace('turn:next', true);
    expect(activityMetricsExpanded('turn:first')).toBe(true);
    expect(activityMetricsExpanded('turn:next')).toBe(false);
    toggleActivityMetrics('turn:next');
    resetActivityTraceView();
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(false);
  });
});

describe('activity trace follow intent', () => {
  it.each(['none', 'browse', 'collapse'] as const)('automatically opens a new owner after %s', (prior) => {
    if (prior !== 'none') {
      toggleActivityTrace('turn:first', true);
      if (prior === 'browse') pauseActivityTrace('turn:first');
      else toggleActivityTrace('turn:first');
    }
    inheritActivityTrace('turn:next', true);
    expect(activityTraceView('turn:first', true).expanded).toBe(false);
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: true, following: true });
    expect(activityTraceFollowing('turn:next')).toBe(true);
    expect(activityTraceView('turn:next')).toEqual({ expanded: true, following: false });
    toggleActivityTrace('turn:next');
    expect(activityTraceFollowing('turn:next')).toBe(false);
  });
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
