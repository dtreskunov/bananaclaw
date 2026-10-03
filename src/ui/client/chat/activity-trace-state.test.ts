import { beforeEach, describe, expect, it } from 'vitest';
import {
  activityTraceView,
  DEFAULT_TRACE_VIEW,
  resetActivityTraceViews,
  toggleActivityTrace,
  transferActivityTraceViews,
  updateActivityTraceView,
} from './src/activity-trace-state';
import { testTurn } from './src/conversation-test-fixtures';
import type { ChatMessage } from './src/types';

const lines = [0, 1, 2].map((ordinal) => ({
  ordinal,
  ts: String(1000 + ordinal),
  text: JSON.stringify({
    kind: 'tool',
    id: `call-${ordinal}`,
    tool: 'bash',
    status: 'running',
    detail: `echo ${ordinal}`,
  }),
}));
const live: ChatMessage = {
  id: 'turn:turn-1',
  direction: 'turn',
  text: '',
  ts: '',
  turn: testTurn,
  turnStatus: true,
  activity: lines,
  files: null,
};
const reply: ChatMessage = {
  id: 'reply',
  direction: 'out',
  text: 'Done',
  ts: '',
  turnId: testTurn.id,
  activity: lines,
  statsTurn: { ...testTurn, phase: 'settled', outcome: 'replied' },
  files: null,
};
beforeEach(resetActivityTraceViews);

describe('activity trace view state', () => {
  it('opens the count disclosure with every group and entry collapsed, including on reopening', () => {
    expect(toggleActivityTrace(DEFAULT_TRACE_VIEW, lines)).toEqual({
      expanded: true,
      selectedEntry: null,
      openChapter: null,
    });
    const selected = { expanded: true, selectedEntry: 'activity-1', openChapter: 'activity-0' };
    expect(toggleActivityTrace(toggleActivityTrace(selected, lines), lines)).toEqual({
      expanded: true,
      selectedEntry: null,
      openChapter: null,
    });
  });

  it('opens the live summary at the latest entry and its chapter', () => {
    expect(toggleActivityTrace(DEFAULT_TRACE_VIEW, lines, true)).toEqual({
      expanded: true,
      selectedEntry: 'activity-2',
      openChapter: 'activity-0',
    });
  });

  it('retains the open panel, group and selected step when live activity moves to a completed reply', () => {
    updateActivityTraceView(live.id!, (view) => ({
      ...toggleActivityTrace(view, lines),
      openChapter: 'activity-0',
      selectedEntry: 'activity-1',
    }));
    transferActivityTraceViews([live], [reply]);
    expect(activityTraceView(reply.id!)).toEqual({
      expanded: true,
      openChapter: 'activity-0',
      selectedEntry: 'activity-1',
    });
    expect(activityTraceView(live.id!)).toEqual(DEFAULT_TRACE_VIEW);
  });

  it('retains expansion when the reply arrives before settlement', () => {
    updateActivityTraceView(live.id!, (view) => toggleActivityTrace(view, lines));
    transferActivityTraceViews([live], [{ ...reply, statsTurn: undefined }]);
    expect(activityTraceView(reply.id!).expanded).toBe(true);
  });

  it('keeps the chosen chapter open when trailing steps merge into an existing reply chapter', () => {
    const trailing = lines.map((line) => ({ ...line, ordinal: line.ordinal + 7 }));
    updateActivityTraceView(live.id!, (view) => toggleActivityTrace(view, trailing, true));
    transferActivityTraceViews(
      [{ ...live, activity: trailing }],
      [
        {
          ...reply,
          activity: [
            { ...lines[0], text: JSON.stringify({ kind: 'tool', id: 'earlier', tool: 'bash', status: 'completed' }) },
            ...trailing,
          ],
        },
      ],
    );
    expect(activityTraceView(reply.id!)).toEqual({
      expanded: true,
      selectedEntry: 'activity-9',
      openChapter: 'activity-0',
    });
  });

  it('keeps a closed trace closed and does not overwrite a separately expanded reply', () => {
    updateActivityTraceView(live.id!, (view) => ({ ...view, expanded: false }));
    updateActivityTraceView(reply.id!, (view) => ({ ...view, expanded: true }));
    transferActivityTraceViews([live], [reply]);
    expect(activityTraceView(reply.id!).expanded).toBe(true);
  });

  it('retains outputless turn state and does not transfer to unrelated activity', () => {
    updateActivityTraceView(live.id!, (view) => toggleActivityTrace(view, lines, true));
    transferActivityTraceViews([live], [{ ...live, turn: { ...testTurn, phase: 'settled', outcome: 'silent' } }]);
    expect(activityTraceView(live.id!).expanded).toBe(true);
    transferActivityTraceViews([live], [{ ...reply, turnId: 'other-turn' }]);
    expect(activityTraceView(reply.id!)).toEqual(DEFAULT_TRACE_VIEW);
  });

  it('clears view state when leaving the conversation', () => {
    updateActivityTraceView(reply.id!, (view) => ({ ...view, expanded: true }));
    resetActivityTraceViews();
    expect(activityTraceView(reply.id!)).toEqual(DEFAULT_TRACE_VIEW);
  });
});
