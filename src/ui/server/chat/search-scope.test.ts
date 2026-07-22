import { describe, expect, it } from 'vitest';

import { buildViewerSearchConversations, type ThreadSummary } from './chat.js';

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: 'thread-a',
    sessionId: 'session-a',
    channelType: 'resend',
    messagingGroupId: 'shared-inbox',
    platformId: 'viewer@example.com',
    sessionMode: 'per-thread',
    title: 'Visible thread',
    lastActivityAt: '2026-07-22T00:00:00.000Z',
    messageCount: 1,
    ...overrides,
  };
}

describe('viewer search conversation scope', () => {
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
