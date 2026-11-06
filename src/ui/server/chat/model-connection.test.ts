import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ file: {} as Record<string, string>, claudeInstalled: false }));
vi.mock('../../../env.js', () => ({ readEnvFile: () => config.file }));
vi.mock('../../../providers/provider-container-registry.js', () => ({
  getProviderContainerConfig: () => (config.claudeInstalled ? () => ({}) : undefined),
}));

const model = { tool_call: true, modalities: { output: ['text'] } };
const catalog = {
  nvidia: {
    api: 'https://integrate.api.nvidia.com/v1',
    npm: '@ai-sdk/openai-compatible',
    models: { 'minimaxai/minimax-m3.1-flash': model },
  },
  minimax: {
    api: 'https://api.minimax.io/anthropic/v1',
    npm: '@ai-sdk/anthropic',
    models: { 'MiniMax-M3': model },
  },
  anthropic: {
    api: 'https://api.anthropic.com/v1',
    npm: '@ai-sdk/anthropic',
    models: { 'claude-sonnet': model },
  },
  special: {
    api: 'https://provider.test/v1',
    npm: '@ai-sdk/openai-compatible',
    models: { custom: { ...model, provider: { api: 'https://override.test/custom', npm: '@ai-sdk/anthropic' } } },
  },
};

beforeEach(() => {
  vi.resetModules();
  config.file = {};
  config.claudeInstalled = false;
  for (const key of [
    'NATIVE_BASE_URL',
    'NATIVE_PROTOCOL',
    'OPENCODE_BASE_URL',
    'OPENCODE_PROVIDER',
    'ANTHROPIC_BASE_URL',
  ])
    vi.stubEnv(key, undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog))));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('model credential destination', () => {
  it.each(['native', 'opencode'])('uses NVIDIA, not the model developer, for %s', async (provider) => {
    const { getModelConnection } = await import('./model-connection.js');
    expect(await getModelConnection(provider, 'nvidia/minimaxai/minimax-m3.1-flash')).toEqual({
      resource_url: 'https://integrate.api.nvidia.com/v1/*',
      authentication: { type: 'bearer' },
    });
  });

  it('uses model-specific API and protocol overrides', async () => {
    const { getModelConnection } = await import('./model-connection.js');
    expect(await getModelConnection('native', 'special/custom')).toEqual({
      resource_url: 'https://override.test/custom/*',
      authentication: { type: 'api-key', header: 'x-api-key' },
    });
  });

  it('honors native process overrides ahead of file settings, including freeform models', async () => {
    config.file = { NATIVE_BASE_URL: 'https://file.test/v1' };
    vi.stubEnv('NATIVE_BASE_URL', 'https://operator.test:8443/custom/');
    vi.stubEnv('NATIVE_PROTOCOL', 'anthropic-messages');
    const { getModelConnection } = await import('./model-connection.js');
    expect(await getModelConnection('native', 'custom/unlisted')).toEqual({
      resource_url: 'https://operator.test:8443/custom/*',
      authentication: { type: 'api-key', header: 'x-api-key' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('defaults custom native endpoints to bearer authentication, not the catalog protocol', async () => {
    config.file = { NATIVE_BASE_URL: 'https://operator.test/v1' };
    const { getModelConnection } = await import('./model-connection.js');
    expect(await getModelConnection('native', 'minimax/MiniMax-M3')).toEqual({
      resource_url: 'https://operator.test/v1/*',
      authentication: { type: 'bearer' },
    });
  });

  it('does not apply OpenCode fleet overrides to a selected catalog upstream', async () => {
    config.file = { OPENCODE_BASE_URL: 'https://fleet.test/v1' };
    const { getModelConnection } = await import('./model-connection.js');
    expect((await getModelConnection('opencode', 'nvidia/minimaxai/minimax-m3.1-flash', 'minimax'))?.resource_url).toBe(
      'https://integrate.api.nvidia.com/v1/*',
    );
  });

  it('retains the effective upstream for freeform OpenCode models', async () => {
    config.file = { OPENCODE_BASE_URL: 'https://fleet.test/v1', OPENCODE_PROVIDER: 'nvidia' };
    const { getModelConnection } = await import('./model-connection.js');
    expect((await getModelConnection('opencode', 'nvidia/new-model'))?.resource_url).toBe('https://fleet.test/v1/*');
    expect((await getModelConnection('opencode', 'nvidia/new-model', 'nvidia'))?.resource_url).toBe(
      'https://integrate.api.nvidia.com/v1/*',
    );
  });

  it('respects Claude custom endpoints only when the host adapter is installed', async () => {
    config.file = { ANTHROPIC_BASE_URL: 'https://custom.test/anthropic/' };
    const { getModelConnection } = await import('./model-connection.js');
    expect(await getModelConnection('claude', 'claude-sonnet')).toEqual({
      resource_url: 'https://api.anthropic.com/v1/*',
      authentication: { type: 'api-key', header: 'x-api-key' },
    });
    config.claudeInstalled = true;
    expect(await getModelConnection('claude', 'claude-sonnet')).toEqual({
      resource_url: 'https://custom.test/anthropic/v1/*',
      authentication: { type: 'bearer' },
    });
  });

  it.each([
    'http://local.test/v1',
    'https://user:password@api.test/v1',
    'https://api.test/v1?key=private',
    'https://${REGION}.test/v1',
  ])('does not suggest unsafe credential destinations: %s', async (base) => {
    vi.stubEnv('NATIVE_BASE_URL', base);
    const { getModelConnection } = await import('./model-connection.js');
    expect(await getModelConnection('native', 'custom/model')).toBeNull();
  });

  it('does not invent endpoints for missing models or unsupported providers', async () => {
    const { getModelConnection } = await import('./model-connection.js');
    expect(await getModelConnection('native', 'nvidia/missing')).toBeNull();
    expect(await getModelConnection('mock', 'anything')).toBeNull();
  });

  it('surfaces invalid native protocol settings', async () => {
    config.file = { NATIVE_BASE_URL: 'https://operator.test', NATIVE_PROTOCOL: 'invalid' };
    const { getModelConnection } = await import('./model-connection.js');
    await expect(getModelConnection('native', 'custom/model')).rejects.toThrow('Unsupported NATIVE_PROTOCOL');
  });
});
