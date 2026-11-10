import { describe, expect, it } from 'bun:test';
import type { MessageInRow } from '../db/messages-in.js';
import { batchThinkingLevel, messageThinkingLevel, thinkingBatch } from './thinking.js';

function message(id: string, thinkingLevel?: string, trigger = 1): MessageInRow {
  return {
    id,
    seq: 2,
    kind: 'chat',
    channel_type: 'web',
    platform_id: 'room',
    thread_id: 'thread',
    content: JSON.stringify({ text: id, ...(thinkingLevel ? { thinkingLevel } : {}) }),
    timestamp: '',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger,
  };
}

describe('thinking batch boundaries', () => {
  it('isolates overrides before and after default messages, even when both explicitly choose the same level', () => {
    const messages = [message('a'), message('b', 'high'), message('c', 'high'), message('d')];
    const batches: string[][] = [];
    while (messages.length) {
      const batch = thinkingBatch(messages);
      batches.push(batch.map((row) => row.id));
      messages.splice(0, batch.length);
    }
    expect(batches).toEqual([['a'], ['b'], ['c'], ['d']]);
  });
  it('keeps accumulated context with the next trigger so the wake gate cannot deadlock', () => {
    const messages = [message('context', undefined, 0), message('override', 'low'), message('later')];
    expect(thinkingBatch(messages).map((row) => row.id)).toEqual(['context', 'override']);
    expect(batchThinkingLevel(thinkingBatch(messages))).toBe('low');
  });
  it('preserves normal default batching and ignores metadata from other channels', () => {
    const messages = [message('a'), message('b')];
    expect(thinkingBatch(messages)).toBe(messages);
    expect(batchThinkingLevel(messages)).toBeUndefined();
    expect(messageThinkingLevel({ ...message('external', 'high'), channel_type: 'telegram' })).toBeUndefined();
    expect(messageThinkingLevel(message('context', 'high', 0))).toBeUndefined();
  });
  it('does not hide malformed override metadata', () => {
    expect(() => messageThinkingLevel({ ...message('bad'), content: '{"thinkingLevel":true}' })).toThrow('Invalid');
    expect(messageThinkingLevel({ ...message('legacy'), content: 'legacy plaintext' })).toBeUndefined();
  });
});
