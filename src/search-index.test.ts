import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: '/tmp/nanoclaw-search-index-test',
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

import { clearSearchIndex, closeSearchDb, indexMessage, initSearchDb, searchMessages } from './search-index.js';

function addMessage(
  id: string,
  sessionId: string,
  threadId: string | null,
  channelType = 'resend',
  text = `shared needle ${id}`,
  messagingGroupId = 'shared-inbox',
): void {
  indexMessage({
    id,
    sessionId,
    agentGroupId: 'agent',
    messagingGroupId,
    channelType,
    threadId,
    direction: 'in',
    timestamp: '2026-07-22T00:00:00.000Z',
    text,
  });
}

beforeEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  initSearchDb();
});

afterEach(() => {
  closeSearchDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('search conversation authorization', () => {
  it('returns only exact allowed session, thread, and channel tuples', () => {
    addMessage('allowed', 'session-a', 'thread-a');
    addMessage('other-thread', 'session-a', 'thread-b');
    addMessage('other-session', 'session-b', 'thread-a');
    addMessage('other-channel', 'session-a', 'thread-a', 'telegram');
    addMessage('threadless', 'session-a', null);

    const results = searchMessages('needle', {
      agentGroupId: 'agent',
      conversations: [{ sessionId: 'session-a', threadId: 'thread-a', channelType: 'resend' }],
    });

    expect(results.map((row) => row.messageId)).toEqual(['allowed']);
  });

  it('fails closed when the visible conversation allowlist is empty', () => {
    addMessage('private', 'session-a', 'thread-a');

    expect(searchMessages('needle', { agentGroupId: 'agent', conversations: [] })).toEqual([]);
  });

  it('applies the same conversation scope to malformed-query fallback', () => {
    addMessage('allowed', 'session-a', 'thread-a', 'resend', 'shared "needle allowed');
    addMessage('other-user', 'session-b', 'thread-b', 'resend', 'shared "needle private');

    const results = searchMessages('"needle', {
      agentGroupId: 'agent',
      conversations: [{ sessionId: 'session-a', threadId: 'thread-a', channelType: 'resend' }],
    });

    expect(results.map((row) => row.messageId)).toEqual(['allowed']);
  });
});

describe('search index rebuild', () => {
  it('refreshes migrated metadata for an existing message ID', () => {
    addMessage('migrated', 'session-a', 'thread-a', 'web', 'shared needle', 'legacy-web-group');

    clearSearchIndex();
    addMessage('migrated', 'session-a', 'thread-a', 'web', 'shared needle', 'current-shared-web-group');

    const results = searchMessages('needle', {
      agentGroupId: 'agent',
      messagingGroupIds: ['current-shared-web-group'],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.messagingGroupId).toBe('current-shared-web-group');
    expect(
      searchMessages('needle', { agentGroupId: 'agent', messagingGroupIds: ['legacy-web-group'] }),
    ).toEqual([]);
  });
});