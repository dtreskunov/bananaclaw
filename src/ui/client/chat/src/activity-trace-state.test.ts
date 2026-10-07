import { afterEach, describe, expect, it } from 'vitest';
import {
  activityTraceView,
  activityTraceFollowing,
  followActivityTrace,
  inheritActivityPanels,
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

  it('opens metrics for only one turn at a time', () => {
    toggleActivityMetrics('turn:first');
    toggleActivityMetrics('turn:next');
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(true);
    toggleActivityMetrics('turn:next');
    expect(activityMetricsExpanded('turn:next')).toBe(false);
  });

  it('retains selection through settlement and transfers it to the next turn', () => {
    toggleActivityMetrics('turn:first', true);
    expect(activityMetricsExpanded('turn:first')).toBe(true);
    inheritActivityPanels('turn:next');
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(true);
    inheritActivityPanels('turn:next');
    expect(activityMetricsExpanded('turn:next')).toBe(true);
    resetActivityTraceView();
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(false);
  });

  it('keeps manually opened metrics pinned while the trace follows new turns', () => {
    toggleActivityMetrics('turn:first');
    toggleActivityTrace('turn:first', true);
    inheritActivityPanels('turn:next');
    expect(activityMetricsExpanded('turn:first')).toBe(true);
    expect(activityMetricsExpanded('turn:next')).toBe(false);
    expect(activityTraceView('turn:first', true).expanded).toBe(false);
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: true, following: true });
    inheritActivityPanels('turn:third');
    expect(activityMetricsExpanded('turn:first')).toBe(true);
    expect(activityMetricsExpanded('turn:third')).toBe(false);
    toggleActivityMetrics('turn:first');
    inheritActivityPanels('turn:fourth');
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:fourth')).toBe(false);
  });
});

describe('activity trace follow intent', () => {
  it('automatically opens the initial live trace', () => {
    inheritActivityPanels('turn:next', true);
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
    inheritActivityPanels('turn:next');
    expect(activityTraceView('turn:first')).toEqual({ expanded: false, following: false });
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: true, following: true });
    inheritActivityPanels('turn:next');
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: true, following: true });
  });

  it.each(['collapse', 'reset'] as const)('does not inherit after %s', (action) => {
    toggleActivityTrace('turn:first', true);
    toggleActivityMetrics('turn:first');
    if (action === 'collapse') {
      toggleActivityTrace('turn:first');
      toggleActivityMetrics('turn:first');
    } else resetActivityTraceView();
    inheritActivityPanels('turn:next');
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: false, following: false });
    expect(activityTraceView('turn:first', true).expanded).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(false);
    expect(activityMetricsExpanded('turn:first')).toBe(false);
  });

  it.each([false, true])('retains a manually opened or browsed trace (paused=%s)', (paused) => {
    inheritActivityPanels('turn:first');
    expect(activityTraceView('turn:first', true).expanded).toBe(false);
    toggleActivityTrace('turn:first', paused);
    if (paused) pauseActivityTrace('turn:first');
    toggleActivityMetrics('turn:first', true);
    inheritActivityPanels('turn:next');
    expect(activityTraceView('turn:first', true)).toEqual({ expanded: true, following: false });
    expect(activityTraceView('turn:next', true)).toEqual({ expanded: false, following: false });
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(true);
    inheritActivityPanels('turn:third', true);
    expect(activityTraceView('turn:first', true)).toEqual({ expanded: true, following: false });
    expect(activityTraceView('turn:third', true)).toEqual({ expanded: false, following: false });
    followActivityTrace('turn:first');
    inheritActivityPanels('turn:third');
    expect(activityTraceView('turn:first', true).expanded).toBe(false);
    expect(activityTraceView('turn:third', true)).toEqual({ expanded: true, following: true });
  });
});
