import { describe, expect, it } from 'vitest';

import { activityHint, reduceActivityLines } from './activity.js';

const line = (ts: string, step: object) => ({ ts, text: JSON.stringify(step) });

describe('reduceActivityLines', () => {
  it('merges lifecycle updates by kind and id in first-seen order', () => {
    const result = reduceActivityLines([
      line('10', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'pending' }),
      line('20', { kind: 'reasoning', id: 'r1', text: 'Checked state' }),
      line('30', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed', title: 'Run', durationMs: 1 }),
    ]);

    expect(result).toEqual([
      line('10', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed', title: 'Run', durationMs: 20 }),
      line('20', { kind: 'reasoning', id: 'r1', text: 'Checked state' }),
    ]);
  });

  it('derives tool latency from lifecycle timestamps instead of provider units', () => {
    const [result] = reduceActivityLines([
      line('1000', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'running' }),
      line('9040', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed', durationMs: 8 }),
    ]);
    expect(JSON.parse(result.text)).toMatchObject({ status: 'completed', durationMs: 8040 });
  });

  it('keeps distinct ids and drops malformed or unidentified lines', () => {
    expect(reduceActivityLines([
      { ts: '1', text: 'Thinking…' },
      line('2', { kind: 'tool', tool: 'bash', status: 'running' }),
      line('3', { kind: 'tool', id: 'a', tool: 'read', status: 'running' }),
      line('4', { kind: 'tool', id: 'b', tool: 'read', status: 'running' }),
    ])).toHaveLength(2);
  });
});

describe('activityHint', () => {
  it('matches the primary label of the latest reduced activity', () => {
    expect(activityHint([
      line('1', { kind: 'tool', id: 'a', tool: 'bash', status: 'running' }),
      line('2', { kind: 'tool', id: 'a', tool: 'bash', status: 'completed' }),
    ])).toBe('Used bash ✓');
    expect(activityHint([
      line('1', { kind: 'tool', id: 'a', tool: 'Bash', status: 'running' }),
      line('3', { kind: 'reasoning', id: 'r', text: 'private detail' }),
    ])).toBe('Reasoning…');
  });

  it('uses the same success and error labels shown in trace rows', () => {
    expect(activityHint([line('1', { kind: 'tool', id: 'a', tool: 'Bash', status: 'running' })]))
      .toBe('Using bash…');
    expect(activityHint([line('1', { kind: 'tool', id: 'a', tool: 'Bash', status: 'error' })]))
      .toBe('Used bash ✕');
  });
});
