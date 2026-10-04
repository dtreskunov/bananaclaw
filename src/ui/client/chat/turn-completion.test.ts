import { describe, expect, it } from 'vitest';
import { completedResponseId, responseScrollTop } from './src/turn-completion';
import { testSnapshot, testTurn } from './src/conversation-test-fixtures';
import type { ChatMessage } from './src/types';

const previous = testSnapshot({ turns: [testTurn] }).conversation;
const reply: ChatMessage = {
  id: 'reply',
  direction: 'out',
  text: 'Done',
  ts: '',
  statsTurn: { ...testTurn, phase: 'settled', outcome: 'replied' },
  files: null,
};

describe('completion response scrolling', () => {
  it('targets the response only on an observed live-to-settled transition', () => {
    expect(completedResponseId(previous, [reply])).toBe('reply');
    expect(completedResponseId(null, [reply])).toBeNull();
    expect(completedResponseId({ ...previous, turns: [reply.statsTurn!] }, [reply])).toBeNull();
  });

  it('does not scroll for partial replies, disconnects or outputless settlement', () => {
    expect(completedResponseId(previous, [{ ...reply, statsTurn: undefined }])).toBeNull();
    expect(completedResponseId(previous, [{ ...reply, statsTurn: testTurn }])).toBeNull();
    expect(completedResponseId(previous, [])).toBeNull();
  });

  it('targets the newest response when multiple turns settle in one update', () => {
    const second = { ...testTurn, id: 'second' };
    expect(
      completedResponseId({ ...previous, turns: [testTurn, second] }, [
        reply,
        { ...reply, id: 'second-reply', statsTurn: { ...reply.statsTurn!, id: second.id } },
      ]),
    ).toBe('second-reply');
  });

  it('aligns the top of a long response instead of its bottom', () => {
    expect(responseScrollTop(500, 350, 50)).toBe(800);
    expect(responseScrollTop(800, 50, 50)).toBe(800);
    expect(responseScrollTop(0, 20, 50)).toBe(0);
  });
});
