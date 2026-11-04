import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(),
  postJson: vi.fn(),
}));
import { api, postJson } from './api';
import { runSync, respondInteraction, navigateAttention } from './actions';
import { attentionError, attentionSelection, attentionTargets } from './attention-state';
import { groupId, threadId, channelType, messagingGroupId, refs } from './state';
import { testSnapshot, testThread } from './conversation-test-fixtures';

const target = { id: 'q', origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' } };
beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.clearAllMocks();
  groupId.value = null;
  threadId.value = null;
  channelType.value = 'web';
  messagingGroupId.value = null;
  attentionTargets.value = [target];
  attentionSelection.value = null;
  attentionError.value = null;
  refs.syncRequestId = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  attentionTargets.value = null;
  attentionSelection.value = null;
  attentionError.value = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authoritative attention refresh', () => {
  it('refreshes globally even when no agent is selected', async () => {
    vi.mocked(api).mockResolvedValue({ approvals: [], attention: [] });
    await runSync();
    expect(api).toHaveBeenCalledWith('api/sync', undefined);
    expect(attentionTargets.value).toEqual([]);
  });
  it('presents the stable server order newest-first without mutating its snapshot', async () => {
    const oldest = { ...target, id: 'oldest' };
    const newest = { ...target, id: 'newest' };
    const server = [oldest, newest];
    vi.mocked(api).mockResolvedValue({ approvals: [], attention: server });
    await runSync();
    expect(attentionTargets.value).toEqual([newest, oldest]);
    expect(server).toEqual([oldest, newest]);
  });
  it.each(['missing', 'network'])('retains the last snapshot on %s failures', async (failure) => {
    if (failure === 'network') vi.mocked(api).mockRejectedValue(new Error('Offline'));
    else vi.mocked(api).mockResolvedValue({ approvals: [] });
    expect(await runSync()).toBe(false);
    expect(attentionTargets.value).toEqual([target]);
    expect(attentionError.value).toBeTruthy();
    expect(console.error).toHaveBeenCalled();
    vi.mocked(api).mockResolvedValue({ approvals: [], attention: [] });
    await runSync();
    expect(attentionError.value).toBeNull();
    expect(attentionTargets.value).toEqual([]);
  });
  it('does not remove attention on HTTP acceptance while canonical state remains pending', async () => {
    vi.mocked(postJson).mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    vi.mocked(api).mockResolvedValue({ approvals: [], attention: [target] });
    expect(await respondInteraction('q', { responseType: 'text', value: 'Answer' })).toBe(true);
    expect(attentionTargets.value).toEqual([target]);
  });
  it('does not let an older failed refresh invalidate a newer authoritative snapshot', async () => {
    let rejectOld: (error: Error) => void = () => {
      throw new Error('Old request not started');
    };
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const old = runSync();
    vi.mocked(api).mockResolvedValue({ approvals: [], attention: [] });
    await runSync();
    rejectOld(new Error('Outdated failure'));
    await old;
    expect(attentionTargets.value).toEqual([]);
    expect(attentionError.value).toBeNull();
  });
  it('navigates requests cyclically without changing request state or creating a thread', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    messagingGroupId.value = 'm';
    attentionTargets.value = [target, { ...target, id: 'second' }];
    expect(await navigateAttention()).toBe(true);
    expect(attentionSelection.value?.id).toBe('q');
    expect(await navigateAttention()).toBe(true);
    expect(attentionSelection.value?.id).toBe('second');
    expect(await navigateAttention()).toBe(true);
    expect(attentionSelection.value?.id).toBe('q');
    expect(await navigateAttention()).toBe(true);
    expect(attentionSelection.value?.id).toBe('second');
    expect(postJson).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(attentionTargets.value).toHaveLength(2);
    expect(threadId.value).toBe('t');
  });
  it('opens the newest request in a thread regardless of the current selection', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    messagingGroupId.value = 'm';
    const newest = { ...target, id: 'newest-in-thread' };
    const older = { ...target, id: 'older-in-thread' };
    attentionTargets.value = [
      { ...target, id: 'newer-elsewhere', origin: { ...target.origin, threadId: 'elsewhere' } },
      { ...target, id: 'other-channel', origin: { ...target.origin, channelType: 'slack' } },
      { ...target, id: 'other-messaging-group', origin: { ...target.origin, messagingGroupId: 'other' } },
      newest,
      older,
    ];
    attentionSelection.value = { id: older.id, navigation: 0 };
    expect(await navigateAttention({
      agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm',
    })).toBe(true);
    expect(attentionSelection.value?.id).toBe(newest.id);
    expect(api).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
  });
  it('does not navigate a thread badge to a request in another route', async () => {
    attentionTargets.value = [target];
    expect(await navigateAttention({
      agentGroupId: 'g', threadId: 'missing', channelType: 'web', messagingGroupId: 'm',
    })).toBe(false);
    expect(attentionSelection.value).toBeNull();
    expect(api).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
  });
  it('opens the exact cross-agent non-web thread instead of the latest or a new conversation', async () => {
    vi.stubGlobal('location', { hash: '' });
    const destination = {
      id: 'mail-question',
      origin: { agentGroupId: 'other', threadId: 'wanted', channelType: 'resend', messagingGroupId: 'mailbox' },
    };
    const wanted = testThread({ threadId: 'wanted', channelType: 'resend', messagingGroupId: 'mailbox' });
    const latest = testThread({ threadId: 'latest' });
    attentionTargets.value = [destination];
    vi.mocked(api)
      .mockResolvedValueOnce({ approvals: [], attention: [destination], threads: [latest, wanted] })
      .mockResolvedValueOnce({ entries: [] })
      .mockResolvedValueOnce({
        approvals: [],
        attention: [destination],
        threads: [latest, wanted],
        conversation: testSnapshot({ threadId: 'wanted' }),
      });
    expect(await navigateAttention()).toBe(true);
    expect(groupId.value).toBe('other');
    expect(threadId.value).toBe('wanted');
    expect(channelType.value).toBe('resend');
    expect(messagingGroupId.value).toBe('mailbox');
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('channel=resend&mg=mailbox');
    expect(postJson).not.toHaveBeenCalled();
  });
});
