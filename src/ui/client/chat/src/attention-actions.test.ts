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
import { clearChat, runSync, respondInteraction, navigateAttention } from './actions';
import { attentionError, attentionSelection, attentionTargets } from './attention-state';
import { groupId, threadId, channelType, messagingGroupId } from './state';
import { testThread } from './conversation-test-fixtures';
import { installSyncFixture } from './sync-action-test-fixtures';

const target = {
  id: 'approval',
  origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' },
};
let sync: Awaited<ReturnType<typeof installSyncFixture>>;
beforeEach(async () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.clearAllMocks();
  groupId.value = null;
  threadId.value = null;
  channelType.value = 'web';
  messagingGroupId.value = null;
  sync = await installSyncFixture();
  attentionTargets.value = [target];
  attentionSelection.value = null;
  attentionError.value = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  clearChat();
  sync.dispose();
  attentionTargets.value = null;
  attentionSelection.value = null;
  attentionError.value = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authoritative attention refresh', () => {
  it('refreshes globally even when no agent is selected', async () => {
    sync.read.mockResolvedValue({ approvals: [], attention: [] });
    await runSync();
    expect(sync.read).toHaveBeenCalledWith(null);
    expect(api).not.toHaveBeenCalled();
    expect(attentionTargets.value).toEqual([]);
  });
  it('preserves the authoritative oldest-first order without mutating its snapshot', async () => {
    const oldest = { ...target, id: 'oldest' };
    const newest = { ...target, id: 'newest' };
    const server = [oldest, newest];
    sync.read.mockResolvedValue({ approvals: [], attention: server });
    await runSync();
    expect(attentionTargets.value).toEqual([oldest, newest]);
    expect(server).toEqual([oldest, newest]);
  });
  it.each(['missing', 'network'])('retains the last snapshot on %s failures', async (failure) => {
    if (failure === 'network') sync.read.mockRejectedValue(new Error('Offline'));
    else sync.read.mockResolvedValue({ approvals: [] });
    expect(await runSync()).toBe(false);
    expect(attentionTargets.value).toEqual([target]);
    expect(attentionError.value).toBeTruthy();
    expect(console.error).toHaveBeenCalled();
    sync.read.mockResolvedValue({ approvals: [], attention: [] });
    await runSync();
    expect(attentionError.value).toBeNull();
    expect(attentionTargets.value).toEqual([]);
  });
  it('does not remove attention on HTTP acceptance while canonical state remains pending', async () => {
    vi.mocked(postJson).mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    sync.read.mockResolvedValue({ approvals: [], attention: [target] });
    expect(await respondInteraction('approval', { value: 'approve' })).toBe(true);
    expect(attentionTargets.value).toEqual([target]);
  });
  it('does not let an older failed refresh invalidate a newer authoritative snapshot', async () => {
    let rejectOld: (error: Error) => void = () => {
      throw new Error('Old request not started');
    };
    sync.read.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const old = runSync();
    await Promise.resolve();
    sync.sockets[0].close();
    sync.read.mockResolvedValue({ approvals: [], attention: [] });
    await runSync();
    rejectOld(new Error('Outdated failure'));
    await old;
    expect(attentionTargets.value).toEqual([]);
    expect(attentionError.value).toBeNull();
  });
  it('always opens the newest request in the selected agent without changing request state', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    messagingGroupId.value = 'm';
    attentionTargets.value = [
      { ...target, id: 'other-agent', origin: { ...target.origin, agentGroupId: 'other' } },
      target,
      { ...target, id: 'second' },
    ];
    attentionSelection.value = { id: 'second', navigation: 0 };
    expect(await navigateAttention('g')).toBe(true);
    expect(attentionSelection.value?.id).toBe('second');
    expect(await navigateAttention('g')).toBe(true);
    expect(attentionSelection.value?.id).toBe('second');
    expect(postJson).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(attentionTargets.value).toHaveLength(3);
    expect(threadId.value).toBe('t');
  });
  it('opens the newest request in an exact thread regardless of the current selection', async () => {
    groupId.value = 'g';
    threadId.value = 't';
    messagingGroupId.value = 'm';
    const newest = { ...target, id: 'newest-in-thread' };
    const older = { ...target, id: 'older-in-thread' };
    attentionTargets.value = [
      { ...target, id: 'newer-elsewhere', origin: { ...target.origin, threadId: 'elsewhere' } },
      { ...target, id: 'other-channel', origin: { ...target.origin, channelType: 'slack' } },
      { ...target, id: 'other-messaging-group', origin: { ...target.origin, messagingGroupId: 'other' } },
      older,
      newest,
    ];
    attentionSelection.value = { id: older.id, navigation: 0 };
    expect(
      await navigateAttention({
        agentGroupId: 'g',
        threadId: 't',
        channelType: 'web',
        messagingGroupId: 'm',
      }),
    ).toBe(true);
    expect(attentionSelection.value?.id).toBe(newest.id);
    expect(api).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
  });
  it('does not navigate a thread badge to a request in another route', async () => {
    attentionTargets.value = [target];
    expect(
      await navigateAttention({
        agentGroupId: 'g',
        threadId: 'missing',
        channelType: 'web',
        messagingGroupId: 'm',
      }),
    ).toBe(false);
    expect(attentionSelection.value).toBeNull();
    expect(api).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
  });
  it('opens the exact cross-agent non-web thread instead of the latest or a new conversation', async () => {
    const destination = {
      id: 'mail-question',
      origin: { agentGroupId: 'other', threadId: 'wanted', channelType: 'resend', messagingGroupId: 'mailbox' },
    };
    const wanted = testThread({ threadId: 'wanted', channelType: 'resend', messagingGroupId: 'mailbox' });
    const latest = testThread({ threadId: 'latest' });
    attentionTargets.value = [destination];
    sync.read.mockResolvedValue({ approvals: [], attention: [destination], threads: [latest, wanted] });
    vi.mocked(api).mockResolvedValue({ entries: [] });
    expect(await navigateAttention(destination.origin)).toBe(true);
    expect(groupId.value).toBe('other');
    expect(threadId.value).toBe('wanted');
    expect(channelType.value).toBe('resend');
    expect(messagingGroupId.value).toBe('mailbox');
    expect(sync.sockets).toHaveLength(1);
    expect(sync.subscriptions.at(-1)?.conversation).toEqual({
      threadId: 'wanted',
      channelType: 'resend',
      messagingGroupId: 'mailbox',
    });
    expect(postJson).not.toHaveBeenCalled();
  });
  it.each([null, []])('does not navigate without known pending requests: %s', async (targets) => {
    attentionTargets.value = targets;
    expect(await navigateAttention('g')).toBe(false);
    expect(attentionSelection.value).toBeNull();
  });
  it('does not navigate to another agent or act on a stale attention snapshot', async () => {
    expect(await navigateAttention('missing')).toBe(false);
    attentionError.value = 'Offline';
    expect(await navigateAttention('g')).toBe(false);
    expect(attentionSelection.value).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });
});
