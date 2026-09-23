import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissToast, showStickyToast, showToast, Toast } from './components/Toast';
import { toastMessage } from './state';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (toastMessage.value) dismissToast();
  vi.useRealTimers();
});

describe('shared toast policy', () => {
  it('keeps errors until dismissed, even with an explicit timeout', () => {
    showToast('Install failed', 'err', 3000);
    vi.advanceTimersByTime(60_000);
    expect(toastMessage.value?.text).toBe('Install failed');
    expect(vi.getTimerCount()).toBe(0);
    dismissToast();
    expect(toastMessage.value).toBeNull();
  });

  it('auto-dismisses successes after the existing default duration', () => {
    showToast('Saved');
    vi.advanceTimersByTime(1799);
    expect(toastMessage.value?.text).toBe('Saved');
    vi.advanceTimersByTime(1);
    expect(toastMessage.value).toBeNull();
  });

  it('cancels an earlier success timer when an error appears', () => {
    showToast('Saved');
    vi.advanceTimersByTime(1000);
    showToast('Upload failed', 'err');
    vi.advanceTimersByTime(60_000);
    expect(toastMessage.value?.text).toBe('Upload failed');
  });

  it('queues later notifications without losing unread errors', () => {
    showToast('Install failed', 'err');
    showToast('Save failed', 'err');
    showToast('Copied', 'ok', 2500);
    vi.advanceTimersByTime(60_000);
    expect(toastMessage.value?.text).toBe('Install failed');
    dismissToast();
    expect(toastMessage.value?.text).toBe('Save failed');
    vi.advanceTimersByTime(60_000);
    expect(toastMessage.value?.text).toBe('Save failed');
    dismissToast();
    expect(toastMessage.value?.text).toBe('Copied');
    vi.advanceTimersByTime(2499);
    expect(toastMessage.value?.text).toBe('Copied');
    vi.advanceTimersByTime(1);
    expect(toastMessage.value).toBeNull();
  });

  it('preserves sticky actions queued behind an error', () => {
    const action = vi.fn();
    showToast('Failed', 'err');
    showStickyToast('Reload', action);
    expect(toastMessage.value?.text).toBe('Failed');
    dismissToast();
    vi.advanceTimersByTime(60_000);
    expect(toastMessage.value?.text).toBe('Reload');
    expect(action).not.toHaveBeenCalled();
    toastMessage.value?.action?.();
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps replacing transient successes and clears timers on dismissal', () => {
    showToast('First');
    vi.advanceTimersByTime(1000);
    showToast('Second');
    vi.advanceTimersByTime(1000);
    expect(toastMessage.value?.text).toBe('Second');
    dismissToast();
    expect(vi.getTimerCount()).toBe(0);
    expect(toastMessage.value).toBeNull();
  });

  it('renders errors as persistent non-button containers', () => {
    showToast('Failed\nDetails to copy', 'err');
    const node = Toast();
    expect(node?.type).toBe('div');
    expect(node?.props.class).toBe('toast toast-err toast-sticky');
  });
});
