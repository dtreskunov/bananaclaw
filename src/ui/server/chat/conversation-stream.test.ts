import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../shared/conversation.js';
import type { ConversationFrame } from '../../shared/conversation-protocol.js';
import { startConversationStream } from './conversation-stream.js';

const view: Conversation = {
  threadId: 't',
  messages: [],
  turns: [],
  interactions: [],
  timeline: [],
  connection: { connected: false, activeTurnId: null },
  capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
};
afterEach(() => vi.useRealTimers());
describe('conversation stream boundary', () => {
  it('coalesces updates without reads or revision gaps while the socket drains', () => {
    vi.useFakeTimers();
    let ready = false;
    let current = view;
    let invalidate = () => {};
    const read = vi.fn(() => current);
    const frames: Array<ConversationFrame | null> = [];
    const fail = vi.fn();
    const stop = startConversationStream({
      canSend: () => ready,
      read,
      subscribe: (fn) => {
        invalidate = fn;
        return () => {};
      },
      send: (frame) => frames.push(frame),
      fail,
    });
    for (let i = 0; i < 1000; i++) invalidate();
    vi.advanceTimersByTime(400);
    expect(read).not.toHaveBeenCalled();
    ready = true;
    vi.advanceTimersByTime(40);
    expect(frames[0]).toMatchObject({ kind: 'snapshot', revision: 0 });
    ready = false;
    current = { ...view, connection: { connected: true, activeTurnId: null } };
    for (let i = 0; i < 1000; i++) invalidate();
    vi.advanceTimersByTime(400);
    expect(read).toHaveBeenCalledOnce();
    ready = true;
    vi.advanceTimersByTime(40);
    expect(frames[1]).toMatchObject({ kind: 'update', baseRevision: 0, revision: 1 });
    expect(fail).not.toHaveBeenCalled();
    stop();
  });
  it('explicitly clears revoked state and resnapshots it when access returns', () => {
    vi.useFakeTimers();
    let current: Conversation | null = view;
    let invalidate = () => {};
    const frames: Array<ConversationFrame | null> = [];
    const stop = startConversationStream({
      read: () => current,
      subscribe: (fn) => {
        invalidate = fn;
        return () => {};
      },
      send: (frame) => frames.push(frame),
      fail: (error) => {
        throw error;
      },
    });
    current = null;
    invalidate();
    vi.advanceTimersByTime(40);
    expect(frames[1]).toBeNull();
    invalidate();
    vi.advanceTimersByTime(40);
    expect(frames).toHaveLength(2);
    current = view;
    invalidate();
    vi.advanceTimersByTime(40);
    expect(frames[2]).toMatchObject({ kind: 'snapshot', revision: 0, conversation: view });
    expect(frames[2]?.streamId).not.toBe(frames[0]?.streamId);
    stop();
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
        expect(frame).not.toBeNull();
        if (!frame) throw new Error('Expected conversation');
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
