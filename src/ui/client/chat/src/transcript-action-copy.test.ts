import { describe, expect, it } from 'vitest';
import { BRANCH_ACTION_EXPLANATION, editBranchActionExplanation } from './transcript-action-copy';

describe('transcript action explanations', () => {
  it('explains branch scope and shared state', () => {
    expect(BRANCH_ACTION_EXPLANATION).toContain('conversation up to here is copied');
    expect(BRANCH_ACTION_EXPLANATION).toContain('thread is left untouched');
    expect(BRANCH_ACTION_EXPLANATION).toContain('shared, not copied');
  });

  it('explains both historical edit paths before anything is sent', () => {
    expect(editBranchActionExplanation(true)).toContain('new branch immediately before this message');
    expect(editBranchActionExplanation(false)).toContain('new blank web thread');
    for (const message of [editBranchActionExplanation(true), editBranchActionExplanation(false)]) {
      expect(message).toContain('Nothing is sent');
      expect(message).toContain('original thread and message stay unchanged');
    }
  });
});
