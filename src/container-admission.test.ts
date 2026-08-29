/**
 * Unit tests for the pure container-admission policy: admit while the
 * candidate fits the memory budget, evict the LRU idle container when it
 * doesn't, else defer. No DB, filesystem, or live process table involved.
 */
import { describe, expect, it } from 'vitest';

import {
  decideAdmission,
  estimateContainerMb,
  type RunningContainer,
} from './container-admission.js';

function container(over: Partial<RunningContainer> = {}): RunningContainer {
  return {
    sessionId: 's',
    idle: false,
    lastActivityMs: 0,
    estMb: 600,
    ...over,
  };
}

describe('estimateContainerMb', () => {
  it('charges claude for the runner, the MCP sidecar, and the provider CLI', () => {
    expect(estimateContainerMb({ provider: 'claude' })).toBe(600);
  });

  it('drops the MCP sidecar for native, which registers its tools in-process', () => {
    const native = estimateContainerMb({ provider: 'native' });
    expect(native).toBeLessThan(estimateContainerMb({ provider: 'claude' }));
    expect(native).toBe(250);
  });

  it('charges each stdio MCP server as another child process', () => {
    const bare = estimateContainerMb({ provider: 'native' });
    const withServers = estimateContainerMb({
      provider: 'native',
      mcpServers: { a: { type: 'stdio' }, b: {} },
    });
    expect(withServers).toBe(bare + 200);
  });

  it('does not charge for remote MCP servers, which run off-host', () => {
    const bare = estimateContainerMb({ provider: 'native' });
    expect(
      estimateContainerMb({
        provider: 'native',
        mcpServers: { a: { type: 'http' }, b: { type: 'sse' } },
      }),
    ).toBe(bare);
  });

  it('charges an unknown or unresolved provider the most expensive known one', () => {
    expect(estimateContainerMb({ provider: 'not-a-provider' })).toBe(
      estimateContainerMb({ provider: 'claude' }),
    );
    expect(estimateContainerMb({})).toBe(estimateContainerMb({ provider: 'claude' }));
  });
});

describe('decideAdmission', () => {
  it('admits when there is no budget enforcement (0)', () => {
    const d = decideAdmission({
      budgetMb: 0,
      candidateMb: 600,
      running: [container(), container(), container()],
    });
    expect(d).toEqual({ action: 'admit' });
  });

  it('admits while the candidate fits the remaining budget', () => {
    const d = decideAdmission({ budgetMb: 2000, candidateMb: 600, running: [container()] });
    expect(d).toEqual({ action: 'admit' });
  });

  it('fits more cheap containers than expensive ones in the same budget', () => {
    const cheap = [container({ estMb: 250 }), container({ estMb: 250 }), container({ estMb: 250 })];
    expect(decideAdmission({ budgetMb: 1200, candidateMb: 250, running: cheap })).toEqual({
      action: 'admit',
    });

    const pricey = [container({ estMb: 600 }), container({ estMb: 600 })];
    expect(decideAdmission({ budgetMb: 1200, candidateMb: 600, running: pricey }).action).toBe(
      'reject',
    );
  });

  it('evicts the LRU idle container when the candidate does not fit', () => {
    const d = decideAdmission({
      budgetMb: 1200,
      candidateMb: 600,
      running: [
        container({ sessionId: 'busy', idle: false }),
        container({ sessionId: 'old-idle', idle: true, lastActivityMs: 100 }),
        container({ sessionId: 'new-idle', idle: true, lastActivityMs: 500 }),
      ],
    });
    expect(d).toEqual({ action: 'evict', sessionId: 'old-idle' });
  });

  it('rejects when over budget and nothing is idle', () => {
    const d = decideAdmission({
      budgetMb: 1000,
      candidateMb: 600,
      running: [container({ sessionId: 'a' }), container({ sessionId: 'b' })],
    });
    expect(d.action).toBe('reject');
  });

  it('admits a container too large for the whole budget rather than deadlocking', () => {
    const d = decideAdmission({ budgetMb: 400, candidateMb: 600, running: [] });
    expect(d).toEqual({ action: 'admit' });
  });
});
