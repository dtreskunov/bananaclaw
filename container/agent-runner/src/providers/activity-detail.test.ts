import { describe, expect, it } from 'bun:test';
import { pickActivityDetail } from './types.js';

describe('activity detail capture', () => {
  it('records thread-title arguments without recording unrelated input fields', () => {
    expect(pickActivityDetail({ title: 'New thread title', content: 'private file body' })).toBe('New thread title');
  });

  it('preserves primary-argument precedence and never includes file bodies', () => {
    expect(pickActivityDetail({ command: 'echo one\necho two', title: 'Run check' })).toBe('echo one\necho two');
    expect(pickActivityDetail({ content: 'private file body' })).toBeUndefined();
  });

  it('retains the TODO format used by the customized UI', () => {
    expect(
      pickActivityDetail({
        todos: [
          { content: 'Inspect', status: 'completed', priority: 'high' },
          { content: 'Implement', status: 'in_progress' },
          { content: 'Verify', status: 'pending' },
        ],
      }),
    ).toBe('Completed: Inspect (High priority)\nIn progress: Implement\nPending: Verify');
  });
});
