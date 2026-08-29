import { describe, expect, it } from 'bun:test';

import { NativeTodoState, shouldRequireTodos } from './todos.js';

describe('NativeTodoState', () => {
  it('tracks a compact checklist through completion', () => {
    const state = new NativeTodoState();
    expect(
      state.update([
        { id: 'inspect', content: 'Inspect the implementation', status: 'in_progress' },
        { id: 'edit', content: 'Apply the focused change', status: 'pending' },
        { id: 'test', content: 'Run focused validation', status: 'pending' },
      ]).summary,
    ).toEqual({ pending: 2, inProgress: 1, completed: 0 });

    expect(
      state.update([
        { id: 'inspect', content: 'Inspect the implementation', status: 'completed' },
        { id: 'edit', content: 'Apply the focused change', status: 'in_progress' },
        { id: 'test', content: 'Run focused validation', status: 'pending' },
      ]).summary,
    ).toEqual({ pending: 1, inProgress: 1, completed: 1 });

    expect(
      state.update([
        { id: 'inspect', content: 'Inspect the implementation', status: 'completed' },
        { id: 'edit', content: 'Apply the focused change', status: 'completed' },
        { id: 'test', content: 'Run focused validation', status: 'completed' },
      ]).summary,
    ).toEqual({ pending: 0, inProgress: 0, completed: 3 });
  });

  it('enforces stable items, terminal completion, and one active item', () => {
    const state = new NativeTodoState();
    state.update([
      { id: 'one', content: 'First step', status: 'completed' },
      { id: 'two', content: 'Second step', status: 'in_progress' },
    ]);

    expect(() => state.update([{ id: 'two', content: 'Second step', status: 'in_progress' }])).toThrow(/removed/);
    expect(() =>
      state.update([
        { id: 'one', content: 'Renamed step', status: 'completed' },
        { id: 'two', content: 'Second step', status: 'in_progress' },
      ]),
    ).toThrow(/content cannot change/);
    expect(() =>
      state.update([
        { id: 'one', content: 'First step', status: 'pending' },
        { id: 'two', content: 'Second step', status: 'in_progress' },
      ]),
    ).toThrow(/cannot be reopened/);
    expect(() =>
      new NativeTodoState().update([
        { id: 'one', content: 'First step', status: 'in_progress' },
        { id: 'two', content: 'Second step', status: 'in_progress' },
      ]),
    ).toThrow(/Exactly one/);
  });

  it('returns defensive snapshots', () => {
    const state = new NativeTodoState();
    const snapshot = state.update([{ id: 'one', content: 'First step', status: 'in_progress' }]);
    snapshot.todos[0]!.content = 'mutated';
    expect(state.snapshot().todos[0]!.content).toBe('First step');
  });
});

describe('shouldRequireTodos', () => {
  it('recognizes explicit multi-step work without forcing simple turns', () => {
    expect(shouldRequireTodos('Perform this in three steps: inspect, edit, and test.')).toBe(true);
    expect(shouldRequireTodos('1. Inspect\n2. Edit\n3. Test')).toBe(true);
    expect(shouldRequireTodos('First inspect, second edit, and finally test.')).toBe(true);
    expect(shouldRequireTodos('Explain this function.')).toBe(false);
  });

  it('honors an explicit request not to use tools', () => {
    expect(shouldRequireTodos('In three steps, explain this, but do not use any tools.')).toBe(false);
  });
});