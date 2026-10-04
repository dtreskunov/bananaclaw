import { beforeEach, describe, expect, it } from 'vitest';
import {
  activityTraceView,
  DEFAULT_TRACE_VIEW,
  latestActivityTraceView,
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
      followLatest: false,
    });
    const selected = { expanded: true, selectedEntry: 'activity-1', openChapter: 'activity-0', followLatest: true };
    expect(toggleActivityTrace(toggleActivityTrace(selected, lines), lines)).toEqual({
      expanded: true,
      selectedEntry: null,
      openChapter: null,
      followLatest: false,
    });
  });

  it('opens the live summary at the latest entry and its chapter', () => {
    expect(toggleActivityTrace(DEFAULT_TRACE_VIEW, lines, true)).toEqual({
      expanded: true,
      selectedEntry: 'activity-2',
      openChapter: 'activity-0',
      followLatest: true,
    });
  });

  it('retains the open panel, group and selected step when live activity moves to a completed reply', () => {
    updateActivityTraceView(live.id!, (view) => ({
      ...toggleActivityTrace(view, lines),
      openChapter: 'activity-0',
      selectedEntry: 'activity-1',
      followLatest: false,
    }));
    transferActivityTraceViews([live], [reply]);
    expect(activityTraceView(reply.id!)).toEqual({
      expanded: true,
      openChapter: 'activity-0',
      followLatest: false,
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
      followLatest: false,
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

  it('follows the newest step inside a group and replaces both selections when its category changes', () => {
    updateActivityTraceView(live.id!, (view) => toggleActivityTrace(view, lines, true));
    let previous = live;
    for (const [ordinal, tool, group] of [
      [3, 'bash', 'activity-0'],
      [4, 'read', null],
      [5, 'read', 'activity-4'],
      [6, 'edit', null],
      [7, 'edit', 'activity-6'],
    ] as const) {
      const next = { ...previous, activity: [...previous.activity!, nextLine(ordinal, tool)] };
      transferActivityTraceViews([previous], [next]);
      expect(activityTraceView(live.id!)).toEqual({
        expanded: true,
        followLatest: true,
        selectedEntry: `activity-${ordinal}`,
        openChapter: group,
      });
      previous = next;
    }
  });

  it('selects only the final step when a batch arrives and does not reopen paused or count-only details', () => {
    const activity = [...lines, nextLine(3, 'edit'), nextLine(4, 'edit')];
    expect(latestActivityTraceView(toggleActivityTrace(DEFAULT_TRACE_VIEW, lines, true), activity)).toEqual({
      expanded: true,
      followLatest: true,
      selectedEntry: 'activity-4',
      openChapter: 'activity-3',
    });
    const paused = {
      ...toggleActivityTrace(DEFAULT_TRACE_VIEW, lines, true),
      followLatest: false,
      selectedEntry: 'activity-0',
    };
    updateActivityTraceView(live.id!, () => paused);
    transferActivityTraceViews([live], [{ ...live, activity }]);
    expect(activityTraceView(live.id!)).toEqual(paused);
    const counted = toggleActivityTrace(DEFAULT_TRACE_VIEW, lines);
    updateActivityTraceView(live.id!, () => counted);
    transferActivityTraceViews([live], [{ ...live, activity }]);
    expect(activityTraceView(live.id!)).toEqual(counted);
  });

  it('disables following on collapse and resumes only when reopened via the live summary', () => {
    const following = toggleActivityTrace(DEFAULT_TRACE_VIEW, lines, true);
    const closed = toggleActivityTrace(following, lines);
    expect(closed.expanded).toBe(false);
    expect(closed.followLatest).toBe(false);
    updateActivityTraceView(live.id!, () => closed);
    transferActivityTraceViews([live], [{ ...live, activity: [...lines, nextLine(3, 'read')] }]);
    expect(activityTraceView(live.id!)).toEqual(closed);
    expect(toggleActivityTrace(closed, lines).followLatest).toBe(false);
    expect(toggleActivityTrace(closed, lines, true).followLatest).toBe(true);
  });

  it('continues following the live segment after an early response or a steering boundary', () => {
    for (const output of [false, true]) {
      resetActivityTraceViews();
      updateActivityTraceView(live.id!, (view) => toggleActivityTrace(view, lines, true));
      const tail = { ...live, id: `${live.id}:1`, activity: [] };
      const earlier = output ? { ...reply, statsTurn: undefined } : { ...live, turnStatus: false };
      transferActivityTraceViews([live], [earlier, tail]);
      expect(activityTraceView(earlier.id!).followLatest).toBe(false);
      expect(activityTraceView(tail.id!)).toEqual({
        expanded: true,
        followLatest: true,
        selectedEntry: null,
        openChapter: null,
      });
      transferActivityTraceViews([earlier, tail], [earlier, { ...tail, activity: [nextLine(3, 'read')] }]);
      expect(activityTraceView(tail.id!)).toEqual({
        expanded: true,
        followLatest: true,
        selectedEntry: 'activity-3',
        openChapter: null,
      });
    }
  });

  it('shows the final incoming step and ends following on replied or outputless completion', () => {
    const activity = [...lines, nextLine(3, 'read'), nextLine(4, 'read')];
    for (const output of [false, true]) {
      resetActivityTraceViews();
      updateActivityTraceView(live.id!, (view) => toggleActivityTrace(view, lines, true));
      const completed = output
        ? { ...reply, activity }
        : { ...live, activity, turn: { ...testTurn, phase: 'settled' as const, outcome: 'silent' as const } };
      transferActivityTraceViews([live], [completed]);
      expect(activityTraceView(completed.id!)).toEqual({
        expanded: true,
        followLatest: false,
        selectedEntry: 'activity-4',
        openChapter: 'activity-3',
      });
    }
  });
});

function nextLine(ordinal: number, tool: string) {
  return {
    ...lines[0],
    ordinal,
    text: JSON.stringify({
      kind: 'tool',
      id: `call-${ordinal}`,
      tool,
      status: 'running',
      detail: `Step ${ordinal}`,
    }),
  };
}
