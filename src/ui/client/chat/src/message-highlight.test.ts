import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { highlightMessage } from './message-highlight';

function message() {
  const classes = new Set<string>();
  return {
    classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => {
        classes.add(name);
      },
      remove: (name: string) => {
        classes.delete(name);
      },
    },
    getBoundingClientRect: vi.fn(),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

describe('jump target highlighting', () => {
  it('uses the existing two-second pulse and then removes it', () => {
    const target = message();
    highlightMessage(target);
    expect(target.classList.contains('highlight-pulse')).toBe(true);
    expect(target.getBoundingClientRect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(target.classList.contains('highlight-pulse')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(target.classList.contains('highlight-pulse')).toBe(false);
  });

  it('restarts the animation and timeout when jumping to the same target again', () => {
    const target = message();
    highlightMessage(target);
    vi.advanceTimersByTime(1000);
    highlightMessage(target);
    expect(target.getBoundingClientRect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(target.classList.contains('highlight-pulse')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(target.classList.contains('highlight-pulse')).toBe(false);
  });

  it('keeps different target pulses independent', () => {
    const first = message(),
      second = message();
    highlightMessage(first);
    vi.advanceTimersByTime(1000);
    highlightMessage(second);
    vi.advanceTimersByTime(1000);
    expect(first.classList.contains('highlight-pulse')).toBe(false);
    expect(second.classList.contains('highlight-pulse')).toBe(true);
  });
});
