/**
 * Host half of the shared model contract. The container asserts the same
 * fixture in container/agent-runner/src/model-contract.test.ts — the two
 * package trees can't import each other, so the fixture is the only thing
 * keeping them honest. The fixture lives in the container tree because that
 * tree is mounted into running containers and must stay self-contained.
 */
import { describe, it, expect } from 'vitest';

import cases from '../container/agent-runner/src/providers/model-contract-cases.json' with { type: 'json' };
import { normalizeLimits } from './model-limits.js';
import { joinWireModel } from './model-wire.js';

describe('model limits contract', () => {
  for (const c of cases.limits.cases) {
    it(c.why, () => {
      expect(normalizeLimits({ context: c.context, output: c.output })).toEqual({
        context_window: c.context_window,
        max_output_tokens: c.max_output_tokens,
      });
    });
  }
});

describe('model wire contract', () => {
  for (const c of cases.wire.cases) {
    it(`stores fully qualified: ${c.why}`, () => {
      expect(joinWireModel(c.upstream, c.modelId)).toBe(c.stored);
    });
  }
});
