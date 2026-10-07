import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, UnauthorizedError } from './api';
import { loadStartupData, type StartupState } from './startup';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function errorState(states: StartupState[]) {
  const state = states.at(-1);
  if (!state || state.kind !== 'error') throw new Error('Expected a startup error');
  return state;
}

describe('startup recovery', () => {
  let browser: EventTarget;
  let documentState: EventTarget & { hidden: boolean };
  let states: StartupState[];
  let redirect: ReturnType<typeof vi.fn>;

  const onState = (state: StartupState): void => {
    states.push(state);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
    redirect = vi.fn();
    browser = Object.assign(new EventTarget(), {
      location: {
        pathname: '/ui/chat/',
        search: '?settings=1',
        hash: '#g/group/t/thread',
        replace: redirect,
      },
    });
    documentState = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('window', browser);
    vi.stubGlobal('document', documentState);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows loading immediately and stops recovery after success', async () => {
    const removeBrowserListener = vi.spyOn(browser, 'removeEventListener');
    const removeDocumentListener = vi.spyOn(documentState, 'removeEventListener');
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);
    const startup = loadStartupData(load, onState);
    expect(states).toEqual([{ kind: 'loading' }]);
    expect(load).toHaveBeenCalledOnce();

    browser.dispatchEvent(new Event('online'));
    browser.dispatchEvent(new Event('pageshow'));
    documentState.dispatchEvent(new Event('visibilitychange'));
    expect(load).toHaveBeenCalledOnce();

    pending.resolve('ready');
    expect(await startup).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
    expect(removeBrowserListener.mock.calls.map(([event]) => event)).toEqual(['online', 'pageshow']);
    expect(removeDocumentListener.mock.calls.map(([event]) => event)).toEqual(['visibilitychange']);
    browser.dispatchEvent(new Event('online'));
    browser.dispatchEvent(new Event('pageshow'));
    documentState.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(['api/me', 'api/groups'])('recovers when %s fails and aborts the other request', async (failedUrl) => {
    let failing = true;
    const fetch = vi.fn(async (url: string, _opts?: RequestInit) => {
      if (failing && url === failedUrl) return new Response('', { status: 503 });
      return Response.json(url === 'api/me' ? { userId: 'user' } : { groups: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const startup = loadStartupData(
      (signal) =>
        Promise.all([
          api<{ userId: string }>('api/me', { signal }),
          api<{ groups: string[] }>('api/groups', { signal }),
        ]),
      onState,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(errorState(states).message).toBe('HTTP 503');
    expect(console.error).toHaveBeenCalledWith('App startup failed', expect.any(Error));
    for (const [, opts] of fetch.mock.calls) expect(opts?.signal?.aborted).toBe(true);

    failing = false;
    errorState(states).retry();
    expect(await startup).toEqual([{ userId: 'user' }, { groups: [] }]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('automatically retries a network failure after five seconds', async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce('ready');
    const startup = loadStartupData(load, onState);
    await vi.advanceTimersByTimeAsync(0);
    expect(errorState(states).message).toBe('Failed to fetch');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await startup).toBe('ready');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['online', 'pageshow', 'visibilitychange'])(
    'retries immediately on %s without duplicating initialization',
    async (event) => {
      const pending = deferred<string>();
      const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockReturnValueOnce(pending.promise);
      const startup = loadStartupData(load, onState);
      await vi.advanceTimersByTimeAsync(0);
      const retry = errorState(states).retry;

      (event === 'visibilitychange' ? documentState : browser).dispatchEvent(new Event(event));
      retry();
      browser.dispatchEvent(new Event('online'));
      documentState.dispatchEvent(new Event('visibilitychange'));
      expect(load).toHaveBeenCalledTimes(2);
      expect(states.at(-1)).toEqual({ kind: 'loading' });
      pending.resolve('ready');
      expect(await startup).toBe('ready');
      await vi.advanceTimersByTimeAsync(5_000);
      retry();
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it('pauses automatic retries while hidden and recovers on return', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce('ready');
    const startup = loadStartupData(load, onState);
    await vi.advanceTimersByTimeAsync(0);
    documentState.hidden = true;
    await vi.advanceTimersByTimeAsync(20_000);
    browser.dispatchEvent(new Event('online'));
    browser.dispatchEvent(new Event('pageshow'));
    documentState.dispatchEvent(new Event('visibilitychange'));
    expect(load).toHaveBeenCalledOnce();
    documentState.hidden = false;
    documentState.dispatchEvent(new Event('visibilitychange'));
    expect(await startup).toBe('ready');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('aborts stalled requests at ten seconds and can retry', async () => {
    let signal: AbortSignal | undefined;
    const load = vi
      .fn()
      .mockImplementationOnce((requestSignal: AbortSignal) => {
        signal = requestSignal;
        return new Promise((_resolve, reject) => {
          requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
        });
      })
      .mockResolvedValueOnce('ready');
    const startup = loadStartupData(load, onState);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    expect(states).toEqual([{ kind: 'loading' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(errorState(states).message).toBe('The server did not respond within 10 seconds.');
    errorState(states).retry();
    expect(await startup).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the login redirect and does not retry unauthorized requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const startup = loadStartupData((signal) => api('api/me', { signal }), onState);
    await expect(startup).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redirect).toHaveBeenCalledWith(
      '/ui/login?next=' + encodeURIComponent('/ui/chat/?settings=1#g/group/t/thread'),
    );
    expect(states).toEqual([{ kind: 'loading' }, { kind: 'redirecting' }]);
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    browser.dispatchEvent(new Event('online'));
    documentState.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
