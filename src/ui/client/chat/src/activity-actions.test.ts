import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
vi.mock('./components/Toast', () => ({ showToast: vi.fn() }));
import { api } from './api';
import { clearChat, navigateActivity, openChat } from './actions';
import { activitySelection, activityNavigationPending, finishActivityNavigation } from './activity-navigation';
import { attentionError, attentionTargets } from './attention-state';
import { groupId, threadId, channelType, messagingGroupId, drawerOpen, pendingWebSends, searchOpen } from './state';
import { testThread, testWebSubmission } from './conversation-test-fixtures';
import { installSyncFixture } from './sync-action-test-fixtures';
import { showToast } from './components/Toast';
import type { ActivityTarget } from '../../../shared/activity-target';

const destination: ActivityTarget = {
  origin: { agentGroupId: 'g', threadId: 'wanted', channelType: 'web', messagingGroupId: 'mg' },
  anchor: { kind: 'message', id: 'newest-source' },
};
let sync: Awaited<ReturnType<typeof installSyncFixture>>;
beforeEach(async () => {
  vi.clearAllMocks();
  groupId.value = 'g';
  threadId.value = 'wanted';
  channelType.value = 'web';
  messagingGroupId.value = 'mg';
  sync = await installSyncFixture();
  attentionTargets.value = [];
  attentionError.value = null;
  vi.mocked(api).mockResolvedValue(destination);
});
afterEach(() => {
  clearChat();
  sync.dispose();
  pendingWebSends.value = [];
  searchOpen.value = false;
  attentionTargets.value = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('indicator source navigation', () => {
  it('shows feedback before a delayed response and retains it through conversation loading', async () => {
    let resolve!: (target: ActivityTarget) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise<ActivityTarget>((done) => {
          resolve = done;
        }),
    );
    const opening = navigateActivity(destination.origin, { activity: 'idle' });
    const pending = activityNavigationPending.value;
    expect(pending?.scope).toEqual(destination.origin);
    expect(threadId.value).toBe('wanted');
    resolve(destination);
    expect(await opening).toBe(true);
    expect(activityNavigationPending.value?.target).toEqual(destination);
    expect(activityNavigationPending.value?.request).toBe(pending?.request);
    finishActivityNavigation(pending!.request);
    expect(activityNavigationPending.value).toBeNull();
  });

  it('cancels a delayed jump even when the user reselects the already-open thread', async () => {
    let resolve!: (target: ActivityTarget) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise<ActivityTarget>((done) => {
          resolve = done;
        }),
    );
    const opening = navigateActivity('g', { activity: 'idle' });
    await openChat('g', 'wanted', null);
    resolve(destination);
    expect(await opening).toBe(false);
    expect(activityNavigationPending.value).toBeNull();
  });

  it('does not discard a valid lookup merely because the existing socket reconnects', async () => {
    let resolve!: (target: ActivityTarget) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise<ActivityTarget>((done) => {
          resolve = done;
        }),
    );
    const opening = navigateActivity(destination.origin, { activity: 'idle' });
    const request = activityNavigationPending.value?.request;
    sync.sockets[0].close();
    expect(activityNavigationPending.value?.request).toBe(request);
    resolve(destination);
    expect(await opening).toBe(true);
    expect(activitySelection.value?.target).toEqual(destination);
  });

  it.each([
    { activity: 'idle' as const, unread: false, kind: 'latest' },
    { activity: 'running' as const, unread: false, kind: 'running' },
    { activity: 'idle' as const, unread: true, kind: 'unread' },
    { activity: 'running' as const, unread: true, kind: 'unread' },
  ])(
    'opens the exact $kind source, with a new focus request on repeated clicks',
    async ({ activity, unread, kind }) => {
      searchOpen.value = true;
      drawerOpen.threads.value = true;
      const scope = destination.origin;
      expect(await navigateActivity(scope, { activity }, unread)).toBe(true);
      expect(api).toHaveBeenCalledWith(`api/groups/g/activity-target?kind=${kind}&thread=wanted&channel=web&mg=mg`);
      expect(activitySelection.value?.target).toEqual(destination);
      expect(searchOpen.value).toBe(false);
      expect(drawerOpen.threads.value).toBe(false);
      const first = activitySelection.value;
      expect(await navigateActivity(scope, { activity }, unread)).toBe(true);
      expect(activitySelection.value).not.toBe(first);
      expect(activitySelection.value?.request).toBeGreaterThan(first!.request);
    },
  );

  it('opens the returned cross-agent non-web route, never its default/latest thread', async () => {
    const target: ActivityTarget = {
      origin: { agentGroupId: 'other', threadId: 'mail', channelType: 'resend', messagingGroupId: 'mailbox' },
      anchor: { kind: 'message', id: 'originating-input' },
    };
    vi.mocked(api).mockImplementation(async (url) =>
      String(url).includes('activity-target') ? target : { entries: [] },
    );
    const metadata = {
      approvals: [],
      attention: [],
      threads: [
        testThread({ threadId: 'latest' }),
        testThread({
          threadId: 'mail',
          channelType: 'resend',
          messagingGroupId: 'mailbox',
        }),
      ],
    };
    let publishMetadata!: (value: typeof metadata) => void;
    sync.read.mockReturnValue(
      new Promise((done) => {
        publishMetadata = done;
      }),
    );
    expect(await navigateActivity('other', { activity: 'running' })).toBe(true);
    expect(groupId.value).toBe('other');
    expect(threadId.value).toBe('mail');
    expect(channelType.value).toBe('resend');
    expect(messagingGroupId.value).toBe('mailbox');
    expect(activitySelection.value?.target).toEqual(target);
    expect(sync.read).toHaveBeenCalledExactlyOnceWith('other');
    publishMetadata(metadata);
  });

  it('uses the newest canonical waiting request instead of the message endpoint', async () => {
    attentionTargets.value = [
      { id: 'old', origin: destination.origin },
      { id: 'new', origin: destination.origin },
    ];
    expect(await navigateActivity('g', { activity: 'running', waiting: true }, true)).toBe(true);
    expect(activitySelection.value?.target.anchor).toEqual({ kind: 'interaction', id: 'new' });
    expect(api).not.toHaveBeenCalled();
  });

  it('can jump to a local originating input before the host accepts it', async () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    messagingGroupId.value = 'web-group';
    pendingWebSends.value = [testWebSubmission];
    expect(await navigateActivity('group', { activity: 'running' })).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(activitySelection.value?.target).toEqual({
      origin: { agentGroupId: 'group', threadId: 'thread', channelType: 'web', messagingGroupId: 'web-group' },
      anchor: { kind: 'message', id: testWebSubmission.messageId },
    });
  });

  it('ignores a delayed response after navigation or a newer indicator click', async () => {
    let resolve!: (target: ActivityTarget) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise<ActivityTarget>((done) => {
          resolve = done;
        }),
    );
    const first = navigateActivity('g', { activity: 'idle' });
    expect(await navigateActivity('g', { activity: 'idle' })).toBe(true);
    const selection = activitySelection.value;
    resolve({ ...destination, anchor: { kind: 'message', id: 'stale' } });
    expect(await first).toBe(false);
    expect(activitySelection.value).toBe(selection);
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise<ActivityTarget>((done) => {
          resolve = done;
        }),
    );
    const next = navigateActivity('g', { activity: 'idle' });
    clearChat();
    resolve(destination);
    expect(await next).toBe(false);
    expect(activitySelection.value).toBeNull();
    expect(activityNavigationPending.value).toBeNull();
  });

  it.each([404, 403, 503])('surfaces HTTP %s, making only unavailable origins transient', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api).mockRejectedValue(new Error(`HTTP ${status}`));
    expect(await navigateActivity('g', { activity: 'idle' })).toBe(false);
    expect(activitySelection.value).toBeNull();
    expect(activityNavigationPending.value).toBeNull();
    expect(showToast).toHaveBeenCalledWith(`Could not open activity source: HTTP ${status}`, 'err', 5000, {
      transient: status === 404,
    });
  });
});
