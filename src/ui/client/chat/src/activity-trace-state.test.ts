import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  activityTraceExpanded,
  activityTraceOwner,
  activityMetricsExpanded,
  adoptSubmissionTraces,
  inheritActivityPanels,
  resetActivityTraceView,
  submissionTraceOwner,
  toggleActivityTrace,
  toggleActivityMetrics,
} from './activity-trace-state';
import { testTurn } from './conversation-test-fixtures';
import { appearance } from './appearance-state';
import { DEFAULT_APPEARANCE } from './appearance';
import type { ChatMessage } from './types';

afterEach(resetActivityTraceView);

describe('activity panel expansion', () => {
  it('keeps Steps and Stats independent and lets any number stay open', () => {
    toggleActivityTrace('turn:first');
    toggleActivityMetrics('turn:first');
    toggleActivityMetrics('turn:second');
    expect(activityTraceExpanded('turn:first')).toBe(true);
    expect(activityTraceExpanded('turn:second')).toBe(false);
    expect(activityMetricsExpanded('turn:first')).toBe(true);
    expect(activityMetricsExpanded('turn:second')).toBe(true);
    toggleActivityTrace('turn:second');
    toggleActivityMetrics('turn:first');
    expect(activityTraceExpanded('turn:first')).toBe(true);
    expect(activityTraceExpanded('turn:second')).toBe(true);
    expect(activityMetricsExpanded('turn:first')).toBe(false);
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

  it('moves panels opened on a live response to each new one and pins the rest', () => {
    toggleActivityTrace('turn:first', true);
    toggleActivityMetrics('turn:old');
    inheritActivityPanels(submissionTraceOwner('msg-2'));
    expect(activityTraceExpanded(submissionTraceOwner('msg-2'))).toBe(true);
    adoptSubmissionTraces([{ id: 'second', inputIds: ['msg-2'] }]);
    inheritActivityPanels('turn:second');
    expect(activityTraceExpanded('turn:first')).toBe(false);
    expect(activityTraceExpanded('turn:second')).toBe(true);
    expect(activityMetricsExpanded('turn:old')).toBe(true);
    expect(activityMetricsExpanded('turn:second')).toBe(false);
    // Reopening on a settled response pins it there.
    toggleActivityTrace('turn:first');
    inheritActivityPanels('turn:third');
    expect(activityTraceExpanded('turn:first')).toBe(true);
  });

  it('opens the trace for the first live response unless the user already chose', () => {
    const preferences = appearance.peek().preferences;
    onTestFinished(() => {
      appearance.value = { ...appearance.peek(), preferences };
    });
    const technical = (showTechnicalStatus: boolean) => {
      appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus } };
    };
    technical(false);
    inheritActivityPanels('turn:first');
    expect(activityTraceExpanded('turn:first')).toBe(false);
    technical(true);
    inheritActivityPanels('turn:first');
    expect(activityTraceExpanded('turn:first')).toBe(true);
    toggleActivityTrace('turn:first', true);
    inheritActivityPanels('turn:second');
    expect(activityTraceExpanded('turn:second')).toBe(false);
    resetActivityTraceView();
    toggleActivityTrace('turn:old');
    toggleActivityTrace('turn:old');
    inheritActivityPanels('turn:next');
    expect(activityTraceExpanded('turn:next')).toBe(false);
    resetActivityTraceView();
    toggleActivityMetrics('turn:old');
    inheritActivityPanels('turn:next');
    expect(activityTraceExpanded('turn:next')).toBe(true);
    expect(activityMetricsExpanded('turn:old')).toBe(true);
  });
});
