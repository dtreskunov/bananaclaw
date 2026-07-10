import { describe, expect, it } from 'vitest';

import { activityHint, reduceActivityLines } from './activity.js';

const line = (ts: string, step: object) => ({ ts, text: JSON.stringify(step) });

describe('reduceActivityLines', () => {
  it('merges lifecycle updates by kind and id in first-seen order', () => {
    const result = reduceActivityLines([
      line('10', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'pending' }),
      line('20', { kind: 'file', id: 'f1', path: '/tmp/a' }),
      line('30', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed', title: 'Run', durationMs: 1 }),
    ]);

    expect(result).toEqual([
      line('10', { kind: 'tool', id: 'call-1', tool: 'bash', status: 'completed', title: 'Run', durationMs: 20 }),
      line('20', { kind: 'file', id: 'f1', path: '/tmp/a' }),
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

  it('drops legacy reasoning activity rows', () => {
    expect(reduceActivityLines([
      line('1', { kind: 'reasoning', id: 'r1', text: 'private detail' }),
      line('2', { kind: 'tool', id: 'a', tool: 'bash', status: 'completed' }),
    ])).toEqual([
      line('2', { kind: 'tool', id: 'a', tool: 'bash', status: 'completed' }),
    ]);
  });
});

describe('activityHint', () => {
  it('matches the primary label of the latest reduced activity', () => {
    expect(activityHint([
      line('1', { kind: 'tool', id: 'a', tool: 'bash', status: 'running' }),
      line('2', { kind: 'tool', id: 'a', tool: 'bash', status: 'completed' }),
    ])).toBe('Used bash ✓');
    expect(activityHint([
      line('1', { kind: 'internal', id: 'i1', text: 'Checking constraints' }),
    ])).toBe('Internal…');
  });

  it('uses the same success and error labels shown in trace rows', () => {
    expect(activityHint([line('1', { kind: 'tool', id: 'a', tool: 'Bash', status: 'running' })]))
      .toBe('Using bash…');
    expect(activityHint([line('1', { kind: 'tool', id: 'a', tool: 'Bash', status: 'error' })]))
      .toBe('Used bash ✕');
  });

  it('prefers a provider tool title over the bare tool name', () => {
    expect(activityHint([
      line('1', { kind: 'tool', id: 'a', tool: 'skill', status: 'running' }),
      line('2', { kind: 'tool', id: 'a', tool: 'skill', status: 'completed', title: 'Loaded skill: agent-browser' }),
    ])).toBe('Loaded skill: agent-browser ✓');
  });

  it('shows the operation verb for file tools (read/write/edit)', () => {
    // OpenCode-style: title is the path; the verb comes from the tool name.
    expect(activityHint([
      line('1', { kind: 'tool', id: 'a', tool: 'write', status: 'running', detail: '/workspace/agent/notes.md' }),
      line('2', { kind: 'tool', id: 'a', tool: 'write', status: 'completed', detail: '/workspace/agent/notes.md', title: 'workspace/agent/notes.md' }),
    ])).toBe('Wrote workspace/agent/notes.md ✓');
    // Claude-style: no title, path comes from detail.
    expect(activityHint([line('1', { kind: 'tool', id: 'b', tool: 'Read', status: 'running', detail: '/workspace/agent/notes.md' })]))
      .toBe('Reading /workspace/agent/notes.md…');
    expect(activityHint([line('1', { kind: 'tool', id: 'c', tool: 'Edit', status: 'error', detail: '/workspace/agent/notes.md' })]))
      .toBe('Edited /workspace/agent/notes.md ✕');
  });
});
