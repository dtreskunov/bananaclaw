import { describe, expect, it } from 'vitest';
import { findEditBranchAnchorId } from './edit-message';
import type { ChatMessage } from './types';

function message(id: string, direction: ChatMessage['direction']): ChatMessage {
  return { id, direction, text: id, files: null, ts: '2026-01-01T00:00:00.000Z' };
}

describe('findEditBranchAnchorId', () => {
  it('uses the preceding conversational message', () => {
    const messages = [message('u1', 'in'), message('a1', 'out'), message('u2', 'in')];

    expect(findEditBranchAnchorId(messages, 'u2')).toBe('a1');
  });

  it('supports consecutive user messages', () => {
    const messages = [message('u1', 'in'), message('u2', 'in')];

    expect(findEditBranchAnchorId(messages, 'u2')).toBe('u1');
  });

  it('skips non-conversational timeline rows', () => {
    const messages = [
      message('a1', 'out'),
      message('event-1', 'event'),
      message('internal-1', 'internal'),
      message('u2', 'in'),
    ];

    expect(findEditBranchAnchorId(messages, 'u2')).toBe('a1');
  });

  it('returns null for the first conversational message', () => {
    expect(findEditBranchAnchorId([message('u1', 'in')], 'u1')).toBeNull();
  });
});
