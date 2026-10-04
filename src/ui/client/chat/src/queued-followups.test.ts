import { describe, expect, it } from 'vitest';
import { testSnapshot } from './conversation-test-fixtures';
import { isQueuedFollowup, splitPendingInputs, splitQueuedFollowups, timelineLayoutKey } from './queued-followups';
import type { ChatMessage } from './types';

const sent = '2026-09-26T00:00:00Z';
const base = Date.parse(sent) * 1000;
function message(id: string, direction: ChatMessage['direction'], timelinePosition?: number): ChatMessage {
  return { id, direction, timelinePosition, text: id, ts: sent, files: null };
}
function followup(id: string): ChatMessage {
  return { ...message(id, 'in'), inputState: { messageId: id, status: 'queued', queuedForNextTurn: true } };
}
function layout(messages: ChatMessage[]) {
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
  return splitQueuedFollowups(ordered);
}
function ids(messages: ChatMessage[]) {
  return messages.map((entry) => entry.id);
}

describe('queued follow-up timeline', () => {
  it('renders waiting steering alongside bottom pending bubbles, then promotes it when applied', () => {
    const steering = { ...followup('steer'), inputState: { messageId: 'steer', status: 'steering' as const } };
    const input = [
      message('initial', 'in', base + 1),
      steering,
      followup('later'),
      message('progress', 'out', base + 2),
    ];
    expect(ids(splitPendingInputs(input).transcript)).toEqual(['initial', 'progress']);
    expect(ids(splitPendingInputs(input).queued)).toEqual(['steer', 'later']);
    const applied = { ...steering, inputState: { ...steering.inputState, status: 'applied' as const } };
    expect(timelineLayoutKey([steering])).not.toBe(timelineLayoutKey([applied]));
    expect(ids(splitPendingInputs([input[0], applied, input[2], input[3]]).transcript)).toEqual([
      'initial',
      'steer',
      'progress',
    ]);
  });
  it('waits for a valid durable position when processing acknowledgement arrives first', () => {
    const queued = followup('followup');
    const initialKey = timelineLayoutKey([queued]);
    const processing = {
      ...queued,
      canEditPending: false,
      inputState: { ...queued.inputState!, status: 'processing' as const },
    };
    expect(layout([processing]).queued).toEqual([processing]);
    expect(timelineLayoutKey([processing])).toBe(initialKey);
    for (const timelinePosition of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isQueuedFollowup({ ...processing, timelinePosition })).toBe(true);
    }
    const positioned = { ...processing, timelinePosition: base + 2 };
    expect(layout([positioned]).queued).toEqual([]);
    expect(layout([positioned]).transcript).toEqual([positioned]);
    expect(timelineLayoutKey([positioned])).not.toBe(initialKey);
    expect(
      isQueuedFollowup({
        ...processing,
        inputState: { ...processing.inputState, timelinePosition: base + 2 },
      }),
    ).toBe(false);
  });
  it('keeps multiple FIFO follow-ups out of an active response transcript', () => {
    const messages = [
      message('initial', 'in', base + 1),
      followup('first'),
      message('progress', 'out', base + 2),
      followup('second'),
      message('answer', 'out', base + 3),
    ];
    expect(ids(layout(messages).transcript)).toEqual(['initial', 'progress', 'answer']);
    expect(ids(layout(messages).queued)).toEqual(['first', 'second']);
  });
  it('promotes at consumption after the prior answer and before its own response with identical sent timestamps', () => {
    const queued = followup('next');
    const messages = [message('initial', 'in', base + 1), queued, message('prior-answer', 'out', base + 2)];
    const oldLayout = timelineLayoutKey(messages);
    const consumed = {
      ...queued,
      timelinePosition: base + 3,
      inputState: { ...queued.inputState!, status: 'processing' as const },
    };
    const live = [messages[0], consumed, messages[2]];
    expect(timelineLayoutKey(live)).not.toBe(oldLayout);
    live.push(message('own-answer', 'out', base + 4));
    expect(ids(layout(live).transcript)).toEqual(['initial', 'prior-answer', 'next', 'own-answer']);
    expect(layout(live).queued).toEqual([]);
    expect(consumed.ts).toBe(sent);
    const refreshed = JSON.parse(JSON.stringify([live[3], live[1], live[0], live[2]])) as ChatMessage[];
    expect(layout(refreshed)).toEqual(layout(live));
    expect(new Set(ids(layout(live).transcript)).size).toBe(4);
  });
  it('retains ordering when processing state clears after completion', () => {
    const messages = [
      message('queued-earlier', 'in', base + 3),
      message('old-answer', 'out', base + 2),
      message('answer', 'out', base + 4),
    ];
    expect(ids(layout(messages).transcript)).toEqual(['old-answer', 'queued-earlier', 'answer']);
  });
  it('leaves idle queued input and steering in the transcript, including legacy messages', () => {
    const initial = { ...message('idle', 'in'), inputState: { messageId: 'idle', status: 'queued' as const } };
    const steering = { ...followup('steer'), inputState: { messageId: 'steer', status: 'steering' as const } };
    expect(isQueuedFollowup(initial)).toBe(false);
    expect(ids(layout([initial, steering, message('legacy', 'out')]).transcript)).toEqual(['idle', 'steer', 'legacy']);
    const legacy = [message('later', 'in'), { ...message('earlier', 'out'), ts: '2026-09-25 23:59:59' }];
    expect(ids(layout(legacy).transcript)).toEqual(['earlier', 'later']);
  });
  it('keeps the queue through Stop and promotes only the consumed successor', () => {
    const first = followup('first');
    const second = followup('second');
    const messages = [first, second, message('stopped-response', 'out', base + 1)];
    expect(ids(layout(messages).queued)).toEqual(['first', 'second']);
    messages[0] = { ...first, timelinePosition: base + 2, inputState: { ...first.inputState!, status: 'processing' } };
    expect(ids(layout(messages).queued)).toEqual(['second']);
    expect(ids(layout(messages).transcript)).toEqual(['stopped-response', 'first']);
  });
});
