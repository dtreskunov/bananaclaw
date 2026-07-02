/**
 * Unit tests for the pure container-admission policy: admit under the cap,
 * evict the LRU idle container at the cap, else defer. No DB, filesystem, or
 * live process table involved.
 */
import { describe, expect, it } from 'vitest';

import { decideAdmission, type RunningContainer } from './container-admission.js';

function container(over: Partial<RunningContainer> = {}): RunningContainer {
  return {
    sessionId: 's',
    idle: false,
    lastActivityMs: 0,
    ...over,
  };
}

describe('decideAdmission', () => {
  it('admits when there is no cap (0)', () => {
    const d = decideAdmission({ maxContainers: 0, running: [container(), container(), container()] });
    expect(d).toEqual({ action: 'admit' });
  });

  it('admits below the cap', () => {
    const d = decideAdmission({ maxContainers: 3, running: [container(), container()] });
    expect(d).toEqual({ action: 'admit' });
  });

  it('evicts the LRU idle container at the cap', () => {
    const d = decideAdmission({
      maxContainers: 2,
      running: [
        container({ sessionId: 'busy', idle: false }),
        container({ sessionId: 'old-idle', idle: true, lastActivityMs: 100 }),
        container({ sessionId: 'new-idle', idle: true, lastActivityMs: 500 }),
      ],
    });
    expect(d).toEqual({ action: 'evict', sessionId: 'old-idle' });
  });

  it('rejects at the cap when nothing is idle', () => {
    const d = decideAdmission({
      maxContainers: 2,
      running: [container({ sessionId: 'a' }), container({ sessionId: 'b' })],
    });
    expect(d.action).toBe('reject');
  });
});
