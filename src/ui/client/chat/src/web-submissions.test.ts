import { describe, expect, it } from 'vitest';
import { conversationTimeline } from '../../../server/chat/conversation-timeline';
import type { Conversation } from '../../../shared/conversation';
import { testSnapshot, testTurn, testWebSubmission } from './conversation-test-fixtures';
import { reconcileWebSubmissions, submissionPresentation, withWebSendState } from './web-submissions';
import type { PendingWebSend, TranscriptRow } from './types';

const send = testWebSubmission;
const input = {
  id: send.messageId,
  direction: 'in' as const,
  text: send.text,
  timestamp: send.timestamp,
  inputState: { messageId: send.messageId, status: 'queued' as const },
};
const echoed = testSnapshot({ messages: [input] }).conversation;
const transcript: TranscriptRow[] = [
  {
    kind: 'message',
    message: { ...input, ts: input.timestamp, files: null },
  },
];
const present = (submissions: PendingWebSend[], view: Conversation | null = null, rows: TranscriptRow[] = []) =>
  submissionPresentation(rows, submissions, view, 'group', 'thread');

describe('web submission presentation', () => {
  it('immediately shows the local message and a single Starting response row without canonical records', () => {
    const view = testSnapshot().conversation;
    const before = JSON.stringify(view);
    const rows = present([send], view);
    expect(rows.map((row) => row.kind)).toEqual(['message', 'starting']);
    expect(rows[0]).toMatchObject({ message: { id: send.messageId, text: send.text, hideInitialQueuedCaption: true } });
    expect(rows[0].kind === 'message' && rows[0].message.timelinePosition).toBeUndefined();
    expect(JSON.stringify(view)).toBe(before);
  });

  it('keeps the same public message identity and Starting response after HTTP acceptance and queued echo', () => {
    const accepted = reconcileWebSubmissions([send], echoed, 'group');
    const rows = present(accepted, echoed, transcript);
    expect(accepted[0]).toMatchObject({ status: 'accepted' });
    expect(accepted[0]).not.toHaveProperty('error');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ message: { id: send.messageId, hideInitialQueuedCaption: true } });
    expect(rows[0].kind === 'message' && rows[0].message.submission).toBeUndefined();
    expect(input.inputState.status).toBe('queued');
  });

  it('hands off only when an authoritative turn owns the input, including turns already settled', () => {
    for (const phase of ['running', 'settled'] as const) {
      const view = testSnapshot({
        messages: [input],
        turns: [{ ...testTurn, phase, inputIds: [send.messageId] }],
        connection: { connected: true, activeTurnId: phase === 'running' ? testTurn.id : null },
      }).conversation;
      expect(reconcileWebSubmissions([send], view, 'group')).toEqual([]);
      expect(present([send], view, transcript).some((row) => row.kind === 'starting')).toBe(false);
      expect(present([], view, transcript)[0]).toMatchObject({ message: { hideInitialQueuedCaption: true } });
    }
  });

  it('never hides genuine queued follow-ups or starts a second response behind an active turn', () => {
    const queued = { ...input, inputState: { ...input.inputState, queuedForNextTurn: true } };
    for (const view of [
      testSnapshot({ messages: [queued] }).conversation,
      testSnapshot({ messages: [input], turns: [testTurn], connection: { connected: true, activeTurnId: testTurn.id } })
        .conversation,
    ]) {
      expect(reconcileWebSubmissions([send], view, 'group')).toEqual([]);
      const rows = present([send], view, [
        { kind: 'message', message: { ...queued, ts: queued.timestamp, files: null } },
      ]);
      expect(rows.some((row) => row.kind === 'starting')).toBe(false);
      expect(rows[0]).not.toMatchObject({ message: { hideInitialQueuedCaption: true } });
    }
    expect(
      present([{ ...send, startsResponse: false, inputHandling: { mode: 'steer', turnId: testTurn.id } }]).some(
        (row) => row.kind === 'starting',
      ),
    ).toBe(false);
  });

  it('keeps failed payloads visible for retry and upgrades late authoritative echoes to acceptance', () => {
    const failed: PendingWebSend = {
      ...send,
      status: 'failed',
      error: 'Offline',
      files: [{ name: 'draft.txt', size: 3 }],
    };
    const rows = present([failed]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message: { submission: { status: 'failed', error: 'Offline' }, files: [{ filename: 'draft.txt', size: 3 }] },
    });
    expect(reconcileWebSubmissions([failed], echoed, 'group')[0].status).toBe('accepted');
    expect(
      present(reconcileWebSubmissions([failed], echoed, 'group'), echoed, transcript).filter(
        (row) => row.kind === 'starting',
      ),
    ).toHaveLength(1);
  });

  it.each(['follow-up', 'busy', 'failed'] as const)(
    'retains an unconfirmed %s packet without showing Starting',
    (scenario) => {
      const submission = withWebSendState(
        { ...send, startsResponse: scenario !== 'follow-up' },
        scenario === 'failed' ? { status: 'failed', error: 'Offline' } : { status: 'sending' },
      );
      const view = testSnapshot(
        scenario === 'busy'
          ? {
              turns: [testTurn],
              connection: { connected: true, activeTurnId: testTurn.id },
            }
          : {},
      ).conversation;
      expect(reconcileWebSubmissions([submission], view, 'group')).toEqual([submission]);
      expect(present([submission], view).map((row) => row.kind)).toEqual(['message']);
      expect(present([submission], view)[0]).toMatchObject({ message: { submission } });
    },
  );

  it.each(['steering', 'applied'] as const)(
    'preserves an authoritative %s receipt even before live connection state catches up',
    (status) => {
      const message = { ...input, inputState: { ...input.inputState, status } };
      const view = testSnapshot({ messages: [message] }).conversation;
      expect(reconcileWebSubmissions([send], view, 'group')).toEqual([]);
      const rows = present([send], view, [
        { kind: 'message', message: { ...message, ts: message.timestamp, files: null } },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toMatchObject({ message: { hideInitialQueuedCaption: true } });
    },
  );

  describe('web submission states', () => {
    it('retains errors only while failed, without changing the captured packet', () => {
      const failed = withWebSendState(send, { status: 'failed', error: 'Offline' });
      for (const status of ['sending', 'accepted'] as const) {
        const next = withWebSendState(failed, { status });
        expect(next).not.toHaveProperty('error');
        expect(next).toMatchObject({ status, clientMessageId: send.clientMessageId, text: send.text });
        expect(next.files).toBe(send.files);
      }
      expect(failed).toMatchObject({ status: 'failed', error: 'Offline' });
    });
  });

  it('scopes local messages and reconciliation by both group and thread', () => {
    for (const other of [
      { ...send, groupId: 'other' },
      { ...send, threadId: 'other' },
    ]) {
      expect(present([other])).toEqual([]);
      expect(reconcileWebSubmissions([other], echoed, 'group')).toEqual([other]);
    }
  });

  it('does not recreate a cancelled input or produce several startup rows for rapid submissions', () => {
    const cancelled = { ...input, inputState: { ...input.inputState, status: 'cancelled' as const } };
    const view = { ...echoed, messages: [cancelled] };
    view.timeline = conversationTimeline(view);
    expect(reconcileWebSubmissions([send], view, 'group')).toEqual([]);
    expect(present([send], view)).toEqual([]);
    const second = { ...send, messageId: 'web-other', clientMessageId: 'other' };
    expect(present([send, second]).filter((row) => row.kind === 'starting')).toHaveLength(1);
  });
});
