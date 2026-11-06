import { parseTimestamp } from './time.js';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: `${process.cwd()}/.test-search-index-${process.pid}`,
}));

vi.mock('./config.js', () => ({ DATA_DIR: TEST_DATA_DIR }));

vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

import { log } from './log.js';
import {
  clearSearchIndex,
  closeSearchDb,
  deleteMessageFromIndex,
  deleteSessionFromIndex,
  extractInboundText,
  indexMessage,
  initSearchDb,
  searchMessages,
  type IndexableMessage,
} from './search-index.js';

function inspectIndex<T>(read: (connection: Database.Database) => T): T {
  const connection = new Database(path.join(TEST_DATA_DIR, 'search.db'));
  try {
    return read(connection);
  } finally {
    connection.close();
  }
}

function occurrence(overrides: Partial<IndexableMessage> = {}): IndexableMessage {
  return {
    id: 'shared:agent',
    sessionId: 'session-a',
    agentGroupId: 'agent',
    messagingGroupId: 'shared-inbox',
    channelType: 'web',
    threadId: 'thread-a',
    direction: 'in',
    timestamp: parseTimestamp('2026-07-22T00:00:00.000Z'),
    text: 'searchable needle',
    ...overrides,
  };
}

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
    timestamp: parseTimestamp('2026-07-22T00:00:00.000Z'),
    text,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  initSearchDb();
});

describe('search occurrence identity', () => {
  it('initializes the current schema directly and reopens without rewriting stable FTS rows', () => {
    indexMessage(occurrence());
    const before = inspectIndex((connection) => ({
      version: connection.pragma('user_version', { simple: true }),
      rows: connection.prepare('SELECT rowid,* FROM message_index').all(),
    }));
    expect(before.version).toBe(2);
    closeSearchDb();
    initSearchDb();
    expect(
      inspectIndex((connection) => ({
        version: connection.pragma('user_version', { simple: true }),
        rows: connection.prepare('SELECT rowid,* FROM message_index').all(),
      })),
    ).toEqual(before);
    expect(searchMessages('need*', { agentGroupId: 'agent' })).toHaveLength(1);
  });

  it.each([0, 1, 99])('refuses populated unsupported version %s without replacing its data', (version) => {
    indexMessage(occurrence());
    closeSearchDb();
    const before = inspectIndex((connection) => {
      connection.pragma(`user_version=${version}`);
      return connection.prepare('SELECT rowid,* FROM message_index').all();
    });
    expect(() => initSearchDb()).toThrow(`Unsupported search storage version ${version}`);
    expect(
      inspectIndex((connection) => ({
        version: connection.pragma('user_version', { simple: true }),
        rows: connection.prepare('SELECT rowid,* FROM message_index').all(),
      })),
    ).toEqual({ version, rows: before });
  });

  it('independently indexes duplicate public IDs across agents, sessions and directions', () => {
    const messages = [
      occurrence(),
      occurrence({ sessionId: 'session-b', threadId: 'thread-b' }),
      occurrence({ direction: 'out', id: 'shared' }),
      occurrence({ agentGroupId: 'other-agent', sessionId: 'session-c', id: 'shared:other-agent' }),
    ];
    for (const msg of messages) {
      indexMessage(msg);
      indexMessage(msg);
    }

    const results = searchMessages('need*', { agentGroupId: 'agent' });
    expect(results).toHaveLength(3);
    expect(results.map((row) => [row.sessionId, row.direction]).sort()).toEqual([
      ['session-a', 'in'],
      ['session-a', 'out'],
      ['session-b', 'in'],
    ]);
    expect(results.every((row) => row.messageId === 'shared' && row.snippet.includes('>>>needle<<<'))).toBe(true);
    expect(searchMessages('need*', { agentGroupId: 'other-agent' }).map((row) => row.messageId)).toEqual(['shared']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stores and returns exact numeric epoch timestamps without internal string conversion', () => {
    indexMessage(occurrence({ id: 'later', timestamp: parseTimestamp('2026-07-22T02:00:00.124+02:00') }));
    indexMessage(occurrence({ id: 'earlier', timestamp: parseTimestamp('2026-07-22T00:00:00.123Z') }));
    expect(searchMessages('need*', { agentGroupId: 'agent' }).map((row) => [row.messageId, row.timestamp])).toEqual([
      ['later', parseTimestamp('2026-07-22T00:00:00.124Z')],
      ['earlier', parseTimestamp('2026-07-22T00:00:00.123Z')],
    ]);
    expect(
      inspectIndex((connection) =>
        connection.prepare('SELECT DISTINCT typeof(timestamp) AS type FROM message_index').all(),
      ),
    ).toEqual([{ type: 'integer' }]);
  });

  it('edits and deletes only the selected occurrence, preserving its stable FTS rowid', () => {
    indexMessage(occurrence());
    indexMessage(occurrence({ direction: 'out', id: 'shared' }));
    indexMessage(occurrence({ sessionId: 'session-b' }));
    const rowidBefore = inspectIndex((connection) =>
      connection.prepare("SELECT rowid FROM message_index WHERE session_id = 'session-a' AND direction = 'in'").get(),
    );

    indexMessage(occurrence({ text: 'replacement token' }), { replaceText: true });

    expect(searchMessages('replace*', { agentGroupId: 'agent' }).map((row) => [row.sessionId, row.direction])).toEqual([
      ['session-a', 'in'],
    ]);
    expect(searchMessages('need*', { agentGroupId: 'agent' })).toHaveLength(2);
    expect(
      inspectIndex((connection) =>
        connection.prepare("SELECT rowid FROM message_index WHERE session_id = 'session-a' AND direction = 'in'").get(),
      ),
    ).toEqual(rowidBefore);

    deleteMessageFromIndex('shared:agent', 'agent', 'session-a');
    expect(searchMessages('replace*', { agentGroupId: 'agent' })).toEqual([]);
    expect(searchMessages('need*', { agentGroupId: 'agent' })).toHaveLength(2);
    deleteMessageFromIndex('shared', 'agent', 'session-a', 'out');
    expect(searchMessages('need*', { agentGroupId: 'agent' }).map((row) => row.sessionId)).toEqual(['session-b']);
    expect(deleteSessionFromIndex('session-b')).toBe(1);
    expect(searchMessages('need*', { agentGroupId: 'agent' })).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('retains independently indexed fork copies when the parent is deleted', () => {
    indexMessage(occurrence());
    indexMessage(occurrence({ sessionId: 'fork', threadId: 'fork-thread', text: 'forked needle' }));
    indexMessage(occurrence({ sessionId: 'sibling', threadId: 'sibling-thread' }));
    indexMessage(occurrence({ id: 'after-cut', timestamp: parseTimestamp('2026-07-23T00:00:00.000Z') }));

    expect(deleteSessionFromIndex('session-a')).toBe(2);
    expect(searchMessages('forked', { agentGroupId: 'agent' }).map((row) => row.sessionId)).toEqual(['fork']);
    const results = searchMessages('need*', { agentGroupId: 'agent' });
    expect(results.map((row) => row.sessionId).sort()).toEqual(['fork', 'sibling']);
    expect(results.every((row) => row.threadId !== 'thread-a')).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps FTS rowids stable across VACUUM and reopening', () => {
    indexMessage(occurrence({ id: 'discard' }));
    indexMessage(occurrence());
    indexMessage(occurrence({ sessionId: 'session-b' }));
    deleteMessageFromIndex('discard', 'agent', 'session-a');
    closeSearchDb();
    const before = inspectIndex((connection) =>
      connection.prepare('SELECT rowid, id, session_id FROM message_index ORDER BY rowid').all(),
    );
    inspectIndex((connection) => connection.exec('VACUUM'));
    initSearchDb();
    initSearchDb();
    closeSearchDb();
    initSearchDb();

    expect(
      inspectIndex((connection) =>
        connection.prepare('SELECT rowid, id, session_id FROM message_index ORDER BY rowid').all(),
      ),
    ).toEqual(before);
    expect(searchMessages('need*', { agentGroupId: 'agent' })).toHaveLength(2);
    expect(log.warn).not.toHaveBeenCalled();
  });
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
  it('removes cancelled input from search and excludes it from rebuild text extraction', () => {
    addMessage('cancelled:agent', 'session-a', 'thread-a');
    addMessage('kept', 'session-b', 'thread-b');
    deleteMessageFromIndex('cancelled:agent', 'agent', 'wrong-session');
    expect(searchMessages('needle', { agentGroupId: 'agent' })).toHaveLength(2);
    deleteMessageFromIndex('cancelled:agent', 'agent', 'session-a');
    expect(searchMessages('needle', { agentGroupId: 'agent' }).map((row) => row.messageId)).toEqual(['kept']);
    expect(extractInboundText(JSON.stringify({ text: 'needle', cancelled: true }))).toBe('');
    expect(extractInboundText('legacy plain text')).toBe('legacy plain text');
  });

  it('replaces only the edited message text and updates full-text matches', () => {
    addMessage('editable:agent', 'session-a', 'thread-a', 'web', 'oldword');
    addMessage('untouched', 'session-b', 'thread-b', 'web', 'oldword');
    indexMessage(
      {
        id: 'editable:agent',
        sessionId: 'session-a',
        agentGroupId: 'agent',
        messagingGroupId: 'shared-inbox',
        channelType: 'web',
        threadId: 'thread-a',
        direction: 'in',
        timestamp: parseTimestamp('2026-07-22T00:00:00.000Z'),
        text: 'newword',
      },
      { replaceText: true },
    );
    expect(searchMessages('newword', { agentGroupId: 'agent' }).map((row) => row.messageId)).toEqual(['editable']);
    expect(searchMessages('oldword', { agentGroupId: 'agent' }).map((row) => row.messageId)).toEqual(['untouched']);
  });

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
    expect(searchMessages('needle', { agentGroupId: 'agent', messagingGroupIds: ['legacy-web-group'] })).toEqual([]);
  });
});
