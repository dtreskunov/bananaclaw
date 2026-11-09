import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listConnections, type SharedConnection } from '../../../modules/credentials/shared-connections.js';

vi.mock('../../../modules/credentials/shared-connections.js', () => ({ listConnections: vi.fn() }));
vi.mock('../../../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../../../providers/provider-container-registry.js', () => ({ getProviderContainerConfig: () => undefined }));

const model = { tool_call: true, modalities: { input: ['text'], output: ['text'] } };
const catalog = {
  alpha: {
    name: 'Alpha',
    api: 'https://alpha.test/v1',
    npm: '@ai-sdk/openai-compatible',
    models: { first: model, second: model },
  },
  groq: {
    name: 'Groq',
    npm: '@ai-sdk/groq',
    models: { 'qwen/qwen3.8-27b': model, second: model },
  },
  special: {
    api: 'https://special.test/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      first: model,
      override: { ...model, provider: { api: 'https://api.groq.com/openai/v1', npm: '@ai-sdk/groq' } },
    },
  },
};

function connection(overrides: Partial<SharedConnection> = {}): SharedConnection {
  return {
    id: 'personal-connection',
    label: 'My account',
    owner: { id: 'native-alice' },
    kind: 'static',
    status: 'ready',
    revision: 'revision',
    services: [
      {
        name: 'api',
        host: 'api.groq.com',
        path: '/openai/v1/*',
        auth: { type: 'bearer', token: 'GROQ_KEY' },
      },
    ],
    credentials: ['GROQ_KEY'],
    grants: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.mocked(listConnections).mockReset().mockResolvedValue([connection()]);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(catalog)));
  for (const key of ['NATIVE_BASE_URL', 'NATIVE_PROTOCOL', 'OPENCODE_BASE_URL', 'OPENCODE_PROVIDER'])
    vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('configured model providers', () => {
  it.each(['native', 'opencode'] as const)(
    'matches actual endpoint credentials for %s without requiring a grant',
    async (provider) => {
      const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
      expect(await listConfiguredModelProviders('web:alice', provider, {})).toEqual(['groq', 'special']);
      expect(listConnections).toHaveBeenCalledExactlyOnceWith('web:alice');
    },
  );

  it.each(['native', 'opencode'] as const)('recognizes MiniMax composite custom headers for %s', async (provider) => {
    const minimax = {
      api: 'https://api.minimax.io/anthropic/v1',
      npm: '@ai-sdk/anthropic',
      models: { 'MiniMax-M3.1-Flash': model },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          minimax,
          'minimax-coding-plan': minimax,
        }),
      ),
    );
    vi.mocked(listConnections).mockResolvedValue([
      connection({
        services: [
          {
            name: 'minimax',
            host: 'api.minimax.io',
            auth: {
              type: 'custom',
              headers: { Authorization: 'Bearer {{ MINIMAX_KEY }}', 'x-api-key': '{{ MINIMAX_KEY }}' },
            },
          },
        ],
      }),
    ]);
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    expect(await listConfiguredModelProviders('web:alice', provider, {})).toEqual(['minimax', 'minimax-coding-plan']);
  });

  it('recognizes custom bearer headers without granting access', async () => {
    vi.mocked(listConnections).mockResolvedValue([
      connection({
        services: [
          {
            name: 'groq',
            host: 'api.groq.com',
            auth: { type: 'custom', headers: { Authorization: 'Bearer {{ GROQ_KEY }}' } },
          },
        ],
      }),
    ]);
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    expect(await listConfiguredModelProviders('web:alice', 'native', {})).toEqual(['groq', 'special']);
  });

  it.each(['draft', 'disabled', 'needs_reconnect'] as const)(
    'does not mark a %s connection configured',
    async (status) => {
      vi.mocked(listConnections).mockResolvedValue([connection({ status })]);
      const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
      expect(await listConfiguredModelProviders('web:alice', 'native', {})).toEqual([]);
    },
  );

  it.each([
    { host: 'api.groq.com', path: '/wrong/*', auth: { type: 'bearer', token: 'KEY' } },
    { host: 'not-groq.test', auth: { type: 'bearer', token: 'KEY' } },
    { host: 'api.groq.com', enabled: false, auth: { type: 'bearer', token: 'KEY' } },
    { host: 'api.groq.com', auth: { type: 'api-key', key: 'KEY', header: 'x-api-key' } },
  ])('does not match incompatible destinations, disabled services or authentication: %j', async (service) => {
    vi.mocked(listConnections).mockResolvedValue([
      connection({ label: 'Groq', services: [{ name: 'api', ...service }] }),
    ]);
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    expect(await listConfiguredModelProviders('web:alice', 'native', {})).toEqual([]);
  });

  it('respects upstream and modality restrictions', async () => {
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    expect(await listConfiguredModelProviders('web:alice', 'native', { upstream: 'groq' })).toEqual(['groq']);
    expect(await listConfiguredModelProviders('web:alice', 'native', { inputModality: 'image' })).toEqual([]);
  });

  it('uses the effective operator endpoint instead of the provider label', async () => {
    vi.stubEnv('NATIVE_BASE_URL', 'https://operator.test/proxy');
    vi.mocked(listConnections).mockResolvedValue([
      connection({
        services: [{ name: 'proxy', host: 'operator.test', path: '/proxy/*', auth: { type: 'bearer', token: 'KEY' } }],
      }),
    ]);
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    expect(await listConfiguredModelProviders('web:alice', 'native', {})).toEqual(['alpha', 'groq', 'special']);
  });

  it('does not reuse another caller’s configured providers', async () => {
    vi.mocked(listConnections).mockImplementation(async (userId) => (userId === 'web:alice' ? [connection()] : []));
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    expect(await listConfiguredModelProviders('web:alice', 'native', {})).toEqual(['groq', 'special']);
    expect(await listConfiguredModelProviders('web:bob', 'native', {})).toEqual([]);
  });

  it('checks a shared provider endpoint only once', async () => {
    const lookup = vi.spyOn(await import('./model-connection.js'), 'getModelConnection');
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    expect(await listConfiguredModelProviders('web:alice', 'native', { upstream: 'alpha' })).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('surfaces credential gateway errors rather than reporting no configured providers', async () => {
    vi.mocked(listConnections).mockRejectedValue(new Error('Credential gateway unavailable'));
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    await expect(listConfiguredModelProviders('web:alice', 'native', {})).rejects.toThrow(
      'Credential gateway unavailable',
    );
  });

  it('surfaces catalog errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    const { listConfiguredModelProviders } = await import('./configured-model-providers.js');
    await expect(listConfiguredModelProviders('web:alice', 'native', {})).rejects.toThrow('Model catalog unavailable');
  });
});
