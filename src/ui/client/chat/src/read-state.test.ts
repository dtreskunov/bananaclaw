import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./components/Toast', () => ({ showToast: vi.fn() }));
import { showToast } from './components/Toast';
import { attachReadTracking } from './read-state';

class Log extends EventTarget {
  scrollHeight = 1000;
  scrollTop = 500;
  clientHeight = 500;
  shown = true;
  getClientRects() { return { length: Number(this.shown) }; }
}
const target = { groupId: 'g', threadId: 'a', channelType: 'web', messagingGroupId: 'mg',
  cursor: { sessionId: 's', key: 'cursor' } };
let log: Log, documentEvents: EventTarget, windowEvents: EventTarget;
let visible = true, focused = true;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  log = new Log(); documentEvents = new EventTarget(); windowEvents = new EventTarget();
  visible = true; focused = true;
  Object.defineProperty(documentEvents, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  Object.assign(documentEvents, { hasFocus: () => focused });
  vi.stubGlobal('document', documentEvents); vi.stubGlobal('window', windowEvents);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks();
});
const attach = () => { cleanups.push(attachReadTracking(log, target)); };

describe('rendered content acknowledgements', () => {
  it('sends only the rendered cursor after the foreground bottom becomes visible', async () => {
    attach();
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe(JSON.stringify(target.cursor));
    windowEvents.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['hidden', 'unfocused', 'scrolled-up', 'not-rendered'] as const)('does not mark %s content read', async reason => {
    if (reason === 'hidden') visible = false;
    if (reason === 'unfocused') focused = false;
    if (reason === 'scrolled-up') log.scrollTop = 0;
    if (reason === 'not-rendered') log.shown = false;
    attach();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks visibility at the debounce boundary and reads when the user returns', async () => {
    attach(); visible = false;
    await vi.advanceTimersByTimeAsync(150);
    expect(fetch).not.toHaveBeenCalled();
    visible = true;
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(150);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('surfaces failures, retains unread and retries on a later user action', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    attach();
    await vi.advanceTimersByTimeAsync(150);
    expect(showToast).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledOnce();
    log.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(150);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
  it('does not send an acknowledgement after the conversation unmounts', async () => {
    attach(); cleanups.pop()!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
  });
});
