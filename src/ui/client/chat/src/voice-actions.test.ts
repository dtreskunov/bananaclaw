import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearChat, openChat, runSync } from './actions';
import { channelType, groupId, threadId, voiceInput } from './state';
import { voice } from './voice-audio';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

afterEach(() => {
  clearChat();
  groupId.value = null;
  vi.restoreAllMocks();
});

describe('voice capability integration', () => {
  it('loads model-independent voice capability for non-web chats through sync', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    channelType.value = 'telegram';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ approvals: [], voiceInput: { backend: 'elevenlabs', ready: true } }),
      }),
    );
    await runSync();
    expect(voiceInput.value).toEqual({ backend: 'elevenlabs', ready: true });
  });

  it('ignores a stale sync capability after navigation', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    let resolve!: (response: object) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    const syncing = runSync();
    clearChat();
    resolve({ ok: true, json: async () => ({ approvals: [], voiceInput: { backend: 'elevenlabs', ready: true } }) });
    await syncing;
    expect(voiceInput.value.ready).toBe(false);
  });

  it('clears voice ownership on navigation but not a no-op same-thread open', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    voiceInput.value = { backend: 'elevenlabs', ready: true };
    const detach = vi.spyOn(voice, 'detach');
    await openChat('g', 't', null);
    expect(detach).not.toHaveBeenCalled();
    expect(voiceInput.value.ready).toBe(true);
    clearChat();
    expect(detach).toHaveBeenCalledOnce();
    expect(voiceInput.value.ready).toBe(false);
  });

  it('interrupts live input with the explicit configuration reason when disabled', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    const interrupt = vi.spyOn(voice, 'interrupt');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          approvals: [],
          voiceInput: { backend: 'elevenlabs', ready: false, reason: 'API key missing' },
        }),
      }),
    );
    await runSync();
    expect(voiceInput.value.reason).toBe('API key missing');
    expect(interrupt).toHaveBeenCalledWith('API key missing');
  });
});
