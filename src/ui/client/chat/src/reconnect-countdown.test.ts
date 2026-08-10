import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReconnectImmediately, startReconnectCountdown } from './reconnect-countdown';

describe('startReconnectCountdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down to an elapsed callback from an absolute deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const ticks: number[] = [];
    const onElapsed = vi.fn();

    startReconnectCountdown(15000, (seconds) => ticks.push(seconds), onElapsed);
    vi.advanceTimersByTime(14999);

    expect(ticks).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(onElapsed).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onElapsed).toHaveBeenCalledOnce();
  });

  it('does not elapse after cancellation', () => {
    vi.useFakeTimers();
    const onElapsed = vi.fn();
    const cancel = startReconnectCountdown(15000, () => {}, onElapsed);

    cancel();
    vi.advanceTimersByTime(15000);

    expect(onElapsed).not.toHaveBeenCalled();
  });

  it('elapses on the first tick after a suspended clock passes the deadline', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-08-10T00:00:00Z');
    vi.setSystemTime(startedAt);
    const onElapsed = vi.fn();

    startReconnectCountdown(15000, () => {}, onElapsed);
    vi.setSystemTime(new Date(startedAt.getTime() + 20000));
    vi.advanceTimersByTime(1000);

    expect(onElapsed).toHaveBeenCalledOnce();
  });
});

describe('runReconnectImmediately', () => {
  it('cancels the countdown before reconnecting synchronously', () => {
    const calls: string[] = [];

    const started = runReconnectImmediately(
      () => calls.push('cancel'),
      () => calls.push('reconnect'),
    );

    expect(started).toBe(true);
    expect(calls).toEqual(['cancel', 'reconnect']);
  });

  it('does nothing when no countdown is pending', () => {
    const reconnect = vi.fn();

    expect(runReconnectImmediately(null, reconnect)).toBe(false);
    expect(reconnect).not.toHaveBeenCalled();
  });
});
