import { UnauthorizedError } from './api';
import { startConnectionTimeout } from './reconnect-countdown';

export type StartupState = { kind: 'loading' | 'redirecting' } | { kind: 'error'; message: string; retry: () => void };

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 5_000;

export function loadStartupData<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onState: (state: StartupState) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let active: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;

    const clearRetry = (): void => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const retryWhenVisible = (): void => {
      if (!document.hidden) void attempt();
    };

    const cleanup = (): void => {
      clearRetry();
      window.removeEventListener('online', retryWhenVisible);
      window.removeEventListener('pageshow', retryWhenVisible);
      document.removeEventListener('visibilitychange', retryWhenVisible);
    };

    const attempt = async (): Promise<void> => {
      if (finished || active) return;
      clearRetry();
      const controller = new AbortController();
      active = controller;
      onState({ kind: 'loading' });
      const cancelTimeout = startConnectionTimeout(REQUEST_TIMEOUT_MS, () => {
        controller.abort(new Error('The server did not respond within 10 seconds.'));
      });
      try {
        const data = await load(controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        finished = true;
        cleanup();
        resolve(data);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Startup reports failures and retries them.
      } catch (error) {
        controller.abort();
        if (error instanceof UnauthorizedError) {
          finished = true;
          cleanup();
          onState({ kind: 'redirecting' });
          reject(error);
          return;
        }
        console.error('App startup failed', error);
        onState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'An unexpected startup error occurred.',
          retry: () => {
            void attempt();
          },
        });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          retryWhenVisible();
        }, RETRY_DELAY_MS);
      } finally {
        cancelTimeout();
        active = null;
      }
    };

    window.addEventListener('online', retryWhenVisible);
    window.addEventListener('pageshow', retryWhenVisible);
    document.addEventListener('visibilitychange', retryWhenVisible);
    void attempt();
  });
}
