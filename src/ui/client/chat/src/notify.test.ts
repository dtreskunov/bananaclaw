import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Worker extends EventTarget {
  postMessage = vi.fn();

  constructor(public state: ServiceWorkerState) {
    super();
  }

  setState(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

const reload = vi.fn();
function setupRegistration(waiting: Worker | null, installing: Worker | null = null) {
  const reg = Object.assign(new EventTarget(), {
    active: new Worker('activated'),
    waiting,
    installing,
    update: vi.fn().mockResolvedValue(undefined),
  });
  const sw = Object.assign(new EventTarget(), {
    controller: reg.active,
    getRegistration: vi.fn().mockResolvedValue(reg),
    register: vi.fn().mockResolvedValue(reg),
  });
  vi.stubGlobal('navigator', { serviceWorker: sw });
  return { reg, sw };
}

async function prompt() {
  const { showClientReloadPrompt } = await import('./notify');
  const { toastMessage } = await import('./state');
  showClientReloadPrompt('Chat protocol changed');
  return toastMessage;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  reload.mockReset();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('location', { reload });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared client reload action', () => {
  it('uses the same Reload action for new versions and activates the worker before reloading once', async () => {
    const worker = new Worker('installed');
    const { reg, sw } = setupRegistration(worker);
    const { initNotif, showClientReloadPrompt } = await import('./notify');
    const { toastMessage } = await import('./state');
    initNotif();
    await vi.waitFor(() =>
      expect(toastMessage.value).toMatchObject({
        text: 'New version available',
        actionLabel: 'Reload',
        kind: 'ok',
      }),
    );
    const id = toastMessage.value?.id;
    showClientReloadPrompt('Chat protocol changed');
    expect(toastMessage.value?.id).toBe(id);
    toastMessage.value?.action?.();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
    expect(reg.update).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    sw.dispatchEvent(new Event('controllerchange'));
    worker.setState('activated');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('updates and waits for the newest installing worker rather than activating an older cached version', async () => {
    const oldWorker = new Worker('installed');
    const worker = new Worker('installing');
    const { reg } = setupRegistration(oldWorker, worker);
    const toast = await prompt();
    const action = toast.value?.action;
    action?.();
    action?.();
    await vi.waitFor(() => expect(reg.update).toHaveBeenCalledOnce());
    expect(oldWorker.postMessage).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    worker.setState('installed');
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    worker.setState('activated');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reloads directly without service worker support', async () => {
    vi.stubGlobal('navigator', {});
    const toast = await prompt();
    toast.value?.action?.();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads directly when no registration exists', async () => {
    const { sw } = setupRegistration(null);
    sw.getRegistration.mockResolvedValue(undefined);
    const toast = await prompt();
    toast.value?.action?.();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it('shows update failures with a retryable Reload action, not Dismiss or a false reload', async () => {
    const { reg } = setupRegistration(null);
    reg.update.mockRejectedValue(new Error('Offline'));
    const toast = await prompt();
    const action = toast.value?.action;
    action?.();
    await vi.waitFor(() => expect(toast.value).toMatchObject({ kind: 'err', actionLabel: 'Reload' }));
    expect(toast.value?.action).toBe(action);
    expect(console.error).toHaveBeenCalledWith('Chat client update failed', expect.any(Error));
    expect(reload).not.toHaveBeenCalled();
    reg.update.mockResolvedValue(undefined);
    toast.value?.action?.();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(reg.update).toHaveBeenCalledTimes(2);
  });

  it('surfaces stalled installation, cleans up its listener, and permits retry', async () => {
    const worker = new Worker('installing');
    const { reg } = setupRegistration(null, worker);
    const toast = await prompt();
    toast.value?.action?.();
    await vi.waitFor(() => expect(reg.update).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(toast.value).toMatchObject({ kind: 'err', actionLabel: 'Reload' });
    expect(reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    worker.setState('installed');
    expect(worker.postMessage).not.toHaveBeenCalled();
    toast.value?.action?.();
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
    worker.setState('activated');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it.each(['redundant', 'postMessage'] as const)(
    'surfaces worker activation failure (%s) without reloading',
    async (failure) => {
      const worker = new Worker(failure === 'redundant' ? 'redundant' : 'installed');
      if (failure === 'postMessage')
        worker.postMessage.mockImplementation(() => {
          throw new Error('Activation failed');
        });
      setupRegistration(worker);
      const toast = await prompt();
      toast.value?.action?.();
      await vi.waitFor(() => expect(toast.value).toMatchObject({ kind: 'err', actionLabel: 'Reload' }));
      expect(reload).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith('Chat client update failed', expect.any(Error));
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
