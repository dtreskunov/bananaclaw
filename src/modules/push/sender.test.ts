import { describe, expect, it } from 'vitest';

import { PUSH_TTL_SECONDS, pushDeliveryOptions, type PushPayload } from './sender.js';

function payload(threadId: string): PushPayload {
  return {
    v: 1,
    kind: 'message',
    groupId: 'ag-team',
    threadId,
    msgId: 'msg-1',
    ts: '2026-08-06T12:00:00.000Z',
  };
}

describe('push delivery options', () => {
  it('retains pushes for six hours', () => {
    expect(pushDeliveryOptions(payload('thread-1')).TTL).toBe(21_600);
    expect(PUSH_TTL_SECONDS).toBe(21_600);
  });

  it('uses a stable URL-safe topic per conversation', () => {
    const first = pushDeliveryOptions(payload('thread-1')).topic;
    const repeated = pushDeliveryOptions({ ...payload('thread-1'), msgId: 'msg-2' }).topic;
    const otherThread = pushDeliveryOptions(payload('thread-2')).topic;

    expect(first).toBe(repeated);
    expect(first).not.toBe(otherThread);
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
