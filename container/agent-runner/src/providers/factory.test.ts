import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';
import { loadProvider } from './index.js';
import { listProviderNames } from './provider-registry.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });

  it('rejects the removed fx provider instead of falling back to Claude', async () => {
    await loadProvider('fx');
    expect(listProviderNames()).not.toContain('fx');
    expect(() => createProvider('fx')).toThrow(/Unknown provider: fx\./);
  });
});
