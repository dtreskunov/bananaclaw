import { describe, expect, it } from 'vitest';

import { buildViewerSearchConversations } from './chat.js';
import type { ThreadSummary } from '../../shared/thread.js';

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: 'thread-a',
    sessionId: 'session-a',
    channelType: 'resend',
    messagingGroupId: 'shared-inbox',
    platformId: 'viewer@example.com',
    sessionMode: 'per-thread',
    title: 'Visible thread',
    lastActivityAt: 1784678400000,
    messageCount: 1,
    activity: 'idle',
    ...overrides,
  };
}

describe('viewer search conversation scope', () => {
  it('maps synthetic peer addresses to exact exchange IDs and rejects missing exchange identities', () => {
    expect(
      buildViewerSearchConversations([
        thread({ threadId: '__agent:session-a/a2a%3Aone%3Apeer', channelType: 'agent', messagingGroupId: 'session-a' }),
        thread({ threadId: '__agent:session-a', channelType: 'agent', messagingGroupId: 'session-a' }),
      ]),
    ).toEqual([{ sessionId: 'session-a', threadId: 'a2a:one:peer', channelType: 'agent' }]);
  });
  it('maps visible threads to exact authorization tuples and removes duplicates', () => {
    expect(buildViewerSearchConversations([thread(), thread()])).toEqual([
      { sessionId: 'session-a', threadId: 'thread-a', channelType: 'resend' },
    ]);
  });

  it('excludes threadless shared DMs because indexed outbound rows have no audience key', () => {
    expect(
      buildViewerSearchConversations([
        thread({
          threadId: '__dm:shared-inbox',
          sessionId: 'shared-session',
          sessionMode: 'shared',
          kind: 'dm',
        }),
      ]),
    ).toEqual([]);
  });
});
