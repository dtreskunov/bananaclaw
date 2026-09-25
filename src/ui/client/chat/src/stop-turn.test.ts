import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTurnState, resetTurnState, stopActiveTurn } from './stop-turn';
import {
  activeTurn,
  canSend,
  channelType,
  groupId,
  messagingGroupId,
  pending,
  pendingWebSends,
  refs,
  stopRequest,
  threadId,
  turnConnected,
} from './state';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

beforeEach(() => {
  vi.useFakeTimers();
  groupId.value = 'group';
  threadId.value = 'thread';
  channelType.value = 'web';
  canSend.value = true;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  applyTurnState({ id: 'turn-1', status: 'running' }, true);
});

afterEach(() => {
  resetTurnState();
  groupId.value = null;
  threadId.value = null;
  messagingGroupId.value = null;
  pending.value = [];
  pendingWebSends.value = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('turn-scoped Stop', () => {
  it('posts the immutable turn ID and waits for runner acknowledgement, not HTTP acceptance', async () => {
    await stopActiveTurn('turn-1');
    expect(fetch).toHaveBeenCalledWith(
      'api/groups/group/chat/thread/stop',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: '{"turnId":"turn-1"}',
      }),
    );
    expect(stopRequest.value).toEqual({ turnId: 'turn-1', busy: true, error: '' });
    expect(activeTurn.value?.status).toBe('running');
    applyTurnState({ id: 'turn-1', status: 'stopping' }, true);
    expect(stopRequest.value?.busy).toBe(true);
    applyTurnState(null, true);
    expect(activeTurn.value).toBeNull();
    expect(stopRequest.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores duplicate pending clicks and stale clicks after the next turn starts', async () => {
    await stopActiveTurn('turn-1');
    await stopActiveTurn('turn-1');
    applyTurnState({ id: 'turn-2', status: 'running' }, true);
    await stopActiveTurn('turn-1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(activeTurn.value?.id).toBe('turn-2');
    expect(stopRequest.value).toBeNull();
  });

  it('preserves drafts, pending files and queued follow-ups', async () => {
    pending.value = [{ name: 'draft.txt', size: 3 }];
    pendingWebSends.value = [{ threadId: 'thread', messageId: 'queued-1' }];
    await stopActiveTurn('turn-1');
    applyTurnState(null, true);
    expect(pending.value).toEqual([{ name: 'draft.txt', size: 3 }]);
    expect(pendingWebSends.value).toEqual([{ threadId: 'thread', messageId: 'queued-1' }]);
  });

  it('scopes external channel stops using the existing context parameters', async () => {
    channelType.value = 'telegram';
    messagingGroupId.value = 'messaging/group';
    await stopActiveTurn('turn-1');
    expect(fetch).toHaveBeenCalledWith(
      'api/groups/group/chat/thread/stop?channel=telegram&mg=messaging%2Fgroup',
      expect.anything(),
    );
  });

  it('does not submit when read-only or disconnected', async () => {
    canSend.value = false;
    await stopActiveTurn('turn-1');
    canSend.value = true;
    applyTurnState(activeTurn.value, false);
    await stopActiveTurn('turn-1');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces server failure and permits retry of the same turn', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"Runner disconnected"}', { status: 503 }));
    await stopActiveTurn('turn-1');
    expect(stopRequest.value).toEqual({ turnId: 'turn-1', busy: false, error: 'Runner disconnected' });
    await stopActiveTurn('turn-1');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stopRequest.value?.busy).toBe(true);
  });

  it('does not claim completion on timeout; permits an idempotent retry', async () => {
    await stopActiveTurn('turn-1');
    applyTurnState({ id: 'turn-1', status: 'stopping' }, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stopRequest.value?.busy).toBe(false);
    expect(stopRequest.value?.error).toContain('not been confirmed');
    expect(activeTurn.value?.id).toBe('turn-1');
    applyTurnState({ id: 'turn-1', status: 'stopping' }, true);
    expect(vi.getTimerCount()).toBe(0);
    await stopActiveTurn('turn-1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds requests that never return', async () => {
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const request = stopActiveTurn('turn-1');
    await vi.advanceTimersByTimeAsync(30_000);
    await request;
    expect(stopRequest.value?.error).toContain('not been confirmed');
    expect(stopRequest.value?.busy).toBe(false);
  });

  it('handles stopping from another tab with a bounded confirmation wait', async () => {
    applyTurnState({ id: 'turn-1', status: 'stopping' }, true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stopRequest.value?.error).toContain('not been confirmed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains an explicit unconfirmed state across disconnect and reconnect', async () => {
    await stopActiveTurn('turn-1');
    applyTurnState(activeTurn.value, false);
    expect(turnConnected.value).toBe(false);
    expect(stopRequest.value?.error).toContain('Connection lost');
    applyTurnState({ id: 'turn-1', status: 'running' }, true);
    await stopActiveTurn('turn-1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not let a late response affect a new turn or a navigated conversation', async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const request = stopActiveTurn('turn-1');
    refs.chatGeneration++;
    resetTurnState();
    applyTurnState({ id: 'turn-2', status: 'running' }, true);
    resolve(new Response('{"error":"Too late"}', { status: 409 }));
    await request;
    expect(stopRequest.value).toBeNull();
    expect(activeTurn.value?.id).toBe('turn-2');
  });
});
