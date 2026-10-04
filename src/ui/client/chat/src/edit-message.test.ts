import { describe, expect, it } from 'vitest';
import { findEditBranchAnchorId } from './edit-message';
import type { ChatMessage } from './types';
import { testSnapshot } from './conversation-test-fixtures';

function message(id: string, direction: ChatMessage['direction']): ChatMessage {
  return { id, direction, text: id, files: null, ts: '2026-01-01T00:00:00.000Z' };
}

describe('findEditBranchAnchorId', () => {
  it('anchors a completed follow-up after the prior response, not its original send-time predecessor', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z') * 1000;
    const messages = [
      { ...message('olderresponse', 'out'), timelinePosition: base + 1 },
      { ...message('inputA', 'in'), timelinePosition: base + 2 },
      // Sent before responseA, but consumed afterward and now completed.
      { ...message('inputB', 'in'), timelinePosition: base + 4 },
      { ...message('responseA', 'out'), timelinePosition: base + 3 },
      { ...message('responseB', 'out'), timelinePosition: base + 5 },
    ];
    const view = testSnapshot({
      messages: messages.map(({ ts, files: _files, ...message }) => ({
        ...message,
        id: message.id!,
        timestamp: ts,
      })),
    }).conversation;
    const ordered = view.timeline.flatMap((row) =>
      row.kind === 'message' ? [messages.find((message) => message.id === row.messageId)!] : [],
    );
    expect(findEditBranchAnchorId(ordered, 'inputB')).toBe('responseA');
  });
  it('never uses a queued or awaiting-position shelf input as a branch anchor', () => {
    const messages = [
      message('responseA', 'out'),
      {
        ...message('queued', 'in'),
        inputState: { messageId: 'queued', status: 'queued' as const, queuedForNextTurn: true },
      },
      {
        ...message('consuming', 'in'),
        inputState: { messageId: 'consuming', status: 'processing' as const, queuedForNextTurn: true },
      },
      message('inputB', 'in'),
    ];
    expect(findEditBranchAnchorId(messages, 'inputB')).toBe('responseA');
  });
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
