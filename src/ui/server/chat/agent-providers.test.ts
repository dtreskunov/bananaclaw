import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../../providers/index.js';
import { getProviderContainerConfig } from '../../../providers/provider-container-registry.js';
import { SELECTABLE_AGENT_PROVIDERS, VALID_AGENT_PROVIDERS } from './agent-providers.js';
import { listModelsForProvider } from './models-catalog.js';

afterEach(() => vi.restoreAllMocks());

describe('installed agent providers', () => {
  it('offers the remaining runtime providers but not the removed backend', () => {
    expect(SELECTABLE_AGENT_PROVIDERS).toEqual(expect.arrayContaining(['claude', 'native', 'opencode']));
    expect(SELECTABLE_AGENT_PROVIDERS).not.toContain('mock');
    expect(SELECTABLE_AGENT_PROVIDERS).not.toContain('fx');
    expect(VALID_AGENT_PROVIDERS).not.toContain('fx');
    expect(getProviderContainerConfig('fx')).toBeUndefined();
  });

  it('does not fetch a catalog for a removed provider', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected catalog fetch'));
    expect(await listModelsForProvider('fx')).toEqual({
      models: [],
      source: 'unavailable',
      upstream: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
