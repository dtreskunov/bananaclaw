import { beforeEach, describe, expect, it } from 'vitest';
import {
  activityTraceOwner,
  activityTraceView,
  pauseActivityTrace,
  resetActivityTraceView,
  toggleActivityTrace,
} from './src/activity-trace-state';
import { testTurn } from './src/conversation-test-fixtures';
import type { ChatMessage } from './src/types';

beforeEach(resetActivityTraceView);

describe('activity trace intent state', () => {
  it('opens one transcript trace at a time', () => {
    toggleActivityTrace('message:first');
    expect(activityTraceView('message:first')).toEqual({ expanded: true, following: false });

    toggleActivityTrace('message:second');
    expect(activityTraceView('message:first')).toEqual({ expanded: false, following: false });
    expect(activityTraceView('message:second')).toEqual({ expanded: true, following: false });
  });

  it('follows only while the claimed turn trace is live', () => {
    toggleActivityTrace('turn:turn-1', true);
    expect(activityTraceView('turn:turn-1', true)).toEqual({ expanded: true, following: true });
    expect(activityTraceView('turn:turn-1')).toEqual({ expanded: true, following: false });
  });

  it('pauses following only for the current owner', () => {
    toggleActivityTrace('turn:turn-1', true);
    pauseActivityTrace('turn:other');
    expect(activityTraceView('turn:turn-1', true).following).toBe(true);

    pauseActivityTrace('turn:turn-1');
    expect(activityTraceView('turn:turn-1', true)).toEqual({ expanded: true, following: false });
  });

  it('collapses the current trace when toggled again', () => {
    toggleActivityTrace('message:first');
    toggleActivityTrace('message:first');
    expect(activityTraceView('message:first')).toEqual({ expanded: false, following: false });
  });

  it('uses one turn owner across live and final rows', () => {
    const reply: ChatMessage = {
      id: 'reply',
      direction: 'out',
      text: 'Done',
      ts: '',
      turnId: testTurn.id,
      turnTraceOwner: true,
      activity: [],
      files: null,
    };
    expect(activityTraceOwner(reply)).toBe('turn:turn-1');
  });

  it('keeps non-owning rows and unrelated messages independent', () => {
    const prior: ChatMessage = {
      id: 'reply',
      direction: 'out',
      text: 'Earlier',
      ts: '',
      turnId: testTurn.id,
      activity: [],
      files: null,
    };
    expect(activityTraceOwner(prior)).toBe('message:reply');
  });

  it('requires an explicit turn ID instead of inferring ownership from accounting', () => {
    const reply: ChatMessage = {
      id: 'reply',
      direction: 'out',
      text: 'Done',
      ts: '',
      statsTurn: testTurn,
      turnTraceOwner: true,
      files: null,
    };
    expect(() => activityTraceOwner(reply)).toThrow('missing its authoritative turn ID');
  });

  it('clears transient state', () => {
    toggleActivityTrace('turn:turn-1', true);
    resetActivityTraceView();
    expect(activityTraceView('turn:turn-1', true)).toEqual({ expanded: false, following: false });
  });
});
