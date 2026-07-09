import { describe, expect, it } from 'vitest';

import { activityHint, reduceActivityLines } from './activity.js';

const line = (ts: string, step: object) => ({ ts, text: JSON.stringify(step) });

describe('reduceActivityLines', () => {
  it('merges lifecycle updates by kind and id in first-seen order', () => {
    const result = reduceActivityLines([
      line('10', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'pending' }),
      line('20', { kind: 'reasoning', id: 'r1', text: 'Checked state' }),
      line('30', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed', title: 'Run', durationMs: 20 }),
    ]);

    expect(result).toEqual([
      line('10', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed', title: 'Run', durationMs: 20 }),
      line('20', { kind: 'reasoning', id: 'r1', text: 'Checked state' }),
    ]);
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
  it('derives hints from the reduced lifecycle and skips reasoning', () => {
    expect(activityHint([
      line('1', { kind: 'tool', id: 'a', tool: 'bash', status: 'running' }),
      line('2', { kind: 'tool', id: 'a', tool: 'bash', status: 'completed' }),
      line('3', { kind: 'reasoning', id: 'r', text: 'private detail' }),
    ])).toBe('Used bash');
  });
});
