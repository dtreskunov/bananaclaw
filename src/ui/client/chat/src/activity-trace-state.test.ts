import { afterEach, describe, expect, it } from 'vitest';
import {
  activityTraceExpanded,
  activityTraceOwner,
  activityMetricsExpanded,
  adoptSubmissionTraces,
  resetActivityTraceView,
  submissionTraceOwner,
  toggleActivityTrace,
  toggleActivityMetrics,
} from './activity-trace-state';
import { testTurn } from './conversation-test-fixtures';
import type { ChatMessage } from './types';

afterEach(resetActivityTraceView);

describe('activity panel expansion', () => {
  it('keeps Steps and Stats independent and opens only one owner per section', () => {
    toggleActivityTrace('turn:first');
    toggleActivityMetrics('turn:first');
    toggleActivityMetrics('turn:second');
    expect(activityTraceExpanded('turn:first')).toBe(true);
    expect(activityTraceExpanded('turn:second')).toBe(false);
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:second')).toBe(true);
    toggleActivityTrace('turn:second');
    expect(activityTraceExpanded('turn:first')).toBe(false);
    expect(activityTraceExpanded('turn:second')).toBe(true);
  });

  describe('activity trace ownership', () => {
    const reply: ChatMessage = {
      id: 'reply',
      direction: 'out',
      text: 'Done',
      ts: '',
      turnId: testTurn.id,
      activity: [],
      files: null,
    };

    it('uses one turn owner across live and final rows', () => {
      expect(activityTraceOwner({ ...reply, turnTraceOwner: true })).toBe('turn:turn-1');
    });

    it('keeps non-owning rows and unrelated messages independent', () => {
      expect(activityTraceOwner(reply)).toBe('message:reply');
      expect(activityTraceOwner({ ...reply, turnId: undefined })).toBe('message:reply');
    });

    it('requires an explicit turn ID instead of inferring ownership from accounting', () => {
      expect(() =>
        activityTraceOwner({
          ...reply,
          turnId: undefined,
          statsTurn: testTurn,
          turnTraceOwner: true,
        }),
      ).toThrow('missing its authoritative turn ID');
    });

    it('requires an authoritative message ID for non-owning rows', () => {
      expect(() => activityTraceOwner({ ...reply, id: '' })).toThrow('missing its authoritative ID');
    });
  });

  it('starts with both sections closed', () => {
    expect(activityTraceExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:first')).toBe(false);
  });

  it('keeps explicitly closed sections closed', () => {
    toggleActivityTrace('turn:first');
    toggleActivityMetrics('turn:first');
    toggleActivityTrace('turn:first');
    toggleActivityMetrics('turn:first');
    expect(activityTraceExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityTraceExpanded('turn:next')).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(false);
  });

  it('opening Steps does not open Stats', () => {
    toggleActivityTrace('turn:first');
    expect(activityTraceExpanded('turn:first')).toBe(true);
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    toggleActivityTrace('turn:first');
    expect(activityTraceExpanded('turn:next')).toBe(false);
  });

  it('resets both selections on conversation navigation', () => {
    toggleActivityTrace('turn:first');
    toggleActivityMetrics('turn:first');
    resetActivityTraceView();
    expect(activityTraceExpanded('turn:first')).toBe(false);
    expect(activityMetricsExpanded('turn:first')).toBe(false);
    expect(activityTraceExpanded('turn:next')).toBe(false);
    expect(activityMetricsExpanded('turn:next')).toBe(false);
  });

  it('keeps a pre-turn trace open when its turn takes over the row', () => {
    toggleActivityTrace(submissionTraceOwner('msg-1'));
    toggleActivityMetrics(submissionTraceOwner('msg-1'));
    adoptSubmissionTraces([{ id: 'other', inputIds: ['msg-0'] }]);
    expect(activityTraceExpanded(submissionTraceOwner('msg-1'))).toBe(true);
    adoptSubmissionTraces([{ id: 'turn-1', inputIds: ['msg-1'] }]);
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
  });
});
