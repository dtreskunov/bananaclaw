import { describe, expect, it } from 'bun:test';

import { truncateActivityStep } from './session-state.js';

describe('truncateActivityStep', () => {
  it('caps tool details and provider errors without changing lifecycle identity', () => {
    const step = truncateActivityStep({
      kind: 'tool', id: 'call-1', tool: 'bash', status: 'error',
      detail: 'd'.repeat(3000), error: 'e'.repeat(3000),
    });
    expect(step).toMatchObject({ kind: 'tool', id: 'call-1', tool: 'bash', status: 'error' });
    if (step.kind !== 'tool') throw new Error('unexpected kind');
    expect(step.detail?.length).toBe(2000);
    expect(step.error?.length).toBe(2000);
  });
});
