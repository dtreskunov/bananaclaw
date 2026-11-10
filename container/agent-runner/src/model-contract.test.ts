/**
 * Container half of the shared model contract. The host asserts the same
 * fixture in src/model-contract.test.ts — the two package trees can't import
 * each other, so the fixture is the only thing keeping them honest.
 */
import { describe, it, expect } from 'bun:test';

import cases from './providers/model-contract-cases.json';
import { normalizeLimits } from './providers/model-catalog.js';
import { stripUpstreamPrefix } from './providers/opencode.js';
import { resolveCatalogEndpoint } from './providers/native/catalog.js';
import { nativeThinkingLevels } from './providers/native/thinking.js';

describe('thinking levels contract', () => {
  for (const c of cases.thinking.cases) {
    it(c.modelId, () => {
      expect(nativeThinkingLevels(c.modelId)).toEqual(c.levels);
    });
  }
});

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
    it(`peels the upstream back off: ${c.why}`, () => {
      expect(stripUpstreamPrefix(c.stored, c.upstream)).toBe(c.modelId);
    });
  }
});

describe('model endpoint contract', () => {
  for (const c of cases.endpoints.cases) {
    it(c.why, () => {
      expect(resolveCatalogEndpoint(c.upstream, c.provider, c.model)).toEqual({
        api: c.api ?? undefined,
        npm: c.npm,
      });
    });
  }
});
