import { describe, expect, it } from 'bun:test';

import { truncateActivityStep } from './session-state.js';

describe('truncateActivityStep', () => {
  it('allows longer reasoning and caps it at 8,000 characters', () => {
    const step = truncateActivityStep({ kind: 'reasoning', id: 'r1', text: 'x'.repeat(9000) });
    expect(step.kind).toBe('reasoning');
    if (step.kind !== 'reasoning') throw new Error('unexpected kind');
    expect(step.text.length).toBe(8000);
    expect(step.text.endsWith('…')).toBe(true);
  });

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
