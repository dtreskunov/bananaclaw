import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../shared/conversation.js';
import type { ConversationFrame } from '../../shared/conversation-protocol.js';
import { conversationSnapshot, sendConversationFrame, startConversationStream } from './conversation-stream.js';

const view: Conversation = {
  threadId: 't',
  messages: [],
  turns: [],
  questions: [],
  timeline: [],
  connection: { connected: false, activeTurnId: null },
  capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
};
afterEach(() => vi.useRealTimers());
describe('conversation stream boundary', () => {
  it('closes a slow transport without adding another frame to its buffer', () => {
    const socket = { bufferedAmount: 1024 * 1024 + 1, readyState: 1, close: vi.fn(), send: vi.fn() };
    expect(() => sendConversationFrame(socket, conversationSnapshot(view))).toThrow('buffer limit');
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(socket.send).not.toHaveBeenCalled();
  });
  it('subscribes before reading and coalesces invalidation at the snapshot boundary', () => {
    vi.useFakeTimers();
    let invalidate = () => {};
    let current = view;
    const frames: ConversationFrame[] = [];
    const fail = vi.fn();
    const stop = startConversationStream({
      subscribe: (fn) => {
        invalidate = fn;
        return vi.fn();
      },
      read: () => {
        invalidate();
        return current;
      },
      send: (frame) => {
        frames.push(frame);
      },
      fail,
    });
    current = { ...view, connection: { connected: true, activeTurnId: null } };
    for (let i = 0; i < 1000; i++) invalidate();
    vi.advanceTimersByTime(40);
    expect(frames.map((frame) => [frame.kind, frame.revision])).toEqual([
      ['snapshot', 0],
      ['update', 1],
    ]);
    vi.advanceTimersByTime(40);
    expect(frames).toHaveLength(2);
    expect(fail).not.toHaveBeenCalled();
    stop();
  });
  it('fails explicitly and removes subscriptions when reads or sends fail', () => {
    const unsubscribe = vi.fn();
    const fail = vi.fn();
    startConversationStream({
      read: () => {
        throw new Error('database unavailable');
      },
      subscribe: () => unsubscribe,
      send: vi.fn(),
      fail,
    });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'database unavailable' }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('does not keep an unbounded queue when transport rejects a slow client', () => {
    const unsubscribe = vi.fn();
    const fail = vi.fn();
    startConversationStream({
      read: () => view,
      subscribe: () => unsubscribe,
      send: () => {
        throw new Error('slow consumer');
      },
      fail,
    });
    expect(fail).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
