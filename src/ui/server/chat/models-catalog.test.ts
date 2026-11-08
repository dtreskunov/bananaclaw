import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const models = [
  {
    id: 'vendor/audio',
    name: 'Audio',
    context_length: 32000,
    architecture: { input_modalities: ['audio'], output_modalities: ['text'] },
  },
  {
    id: 'vendor/text',
    name: 'Text',
    context_length: 64000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
];

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public OpenRouter catalog', () => {
  it('fetches public metadata without Agent Vault or credential headers', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: models })));
    vi.stubGlobal('fetch', fetch);
    const { listModelsForProvider } = await import('./models-catalog.js');
    const result = await listModelsForProvider('openrouter');
    expect(result.source).toBe('openrouter');
    expect(result.models.map((m) => m.id)).toEqual(['vendor/audio', 'vendor/text']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/models');
    expect(options).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(options.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('proxy-authorization')).toBe(false);
  });

  describe('native models.dev catalog', () => {
    it('includes Groq SDK models without explicit API URLs and preserves text/tool requirements', async () => {
      const model = {
        name: 'Qwen3.8 27B',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 131072, output: 16384 },
        cost: { input: 0.8, output: 4 },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          Response.json({
            groq: {
              npm: '@ai-sdk/groq',
              name: 'Groq',
              models: {
                'qwen/qwen3.8-27b': model,
                'no-tools': { ...model, tool_call: false },
                'image-only': { ...model, modalities: { output: ['image'] } },
              },
            },
          }),
        ),
      );
      const { listModelsForProvider } = await import('./models-catalog.js');
      const result = await listModelsForProvider('native', { upstream: 'groq' });
      expect(result.source).toBe('models.dev');
      expect(result.models).toHaveLength(1);
      expect(result.models[0]).toMatchObject({
        id: 'groq/qwen/qwen3.8-27b',
        label: 'Qwen3.8 27B',
        upstream: 'groq',
        upstreamLabel: 'Groq',
        contextWindow: 131072,
        inputCostPerMTok: 0.8,
        outputCostPerMTok: 4,
        modalitiesIn: ['text', 'image'],
      });
    });
  });

  it('preserves caching, modality filtering and model-detail lookup', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: models })));
    vi.stubGlobal('fetch', fetch);
    const { listModelsForProvider, getModelDetails } = await import('./models-catalog.js');
    expect((await listModelsForProvider('openrouter', { inputModality: 'audio' })).models.map((m) => m.id)).toEqual([
      'vendor/audio',
    ]);
    expect((await listModelsForProvider('openrouter', { outputModality: 'text' })).models).toHaveLength(2);
    expect(await getModelDetails('openrouter', 'vendor/text')).toMatchObject({ label: 'Text', contextWindow: 64000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch an OpenRouter catalog for an unsupported provider', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { listModelsForProvider } = await import('./models-catalog.js');
    expect(await listModelsForProvider('unsupported')).toEqual({ models: [], source: 'unavailable', upstream: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces an unavailable catalog without credential-based retries on HTTP failure', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const { listModelsForProvider } = await import('./models-catalog.js');
    expect(await listModelsForProvider('openrouter')).toEqual({ models: [], source: 'unavailable', upstream: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('handles network/timeout failures through the existing unavailable result', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('request timeout'));
    vi.stubGlobal('fetch', fetch);
    const { listModelsForProvider } = await import('./models-catalog.js');
    expect(await listModelsForProvider('openrouter')).toEqual({ models: [], source: 'unavailable', upstream: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
