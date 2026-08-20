import { afterEach, describe, expect, it, vi } from 'vitest';

import { listFxModels, resetGatewayCatalogCache } from './models-gateway-catalog.js';

function model(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'anthropic/claude-opus-4.8',
    name: 'Claude Opus 4.8',
    description: 'A model.',
    owned_by: 'anthropic',
    type: 'language',
    tags: ['tool-use', 'vision'],
    context_window: 1_000_000,
    max_tokens: 128_000,
    knowledge: '2026-01',
    released: 1779926400,
    modalities: { input: ['text', 'image'], output: ['text'] },
    pricing: { input: '0.000005', output: '0.000025' },
    ...over,
  };
}

function stubCatalog(models: unknown[]): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(JSON.stringify({ object: 'list', data: models }), { status: 200 }));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => {
  resetGatewayCatalogCache();
  vi.unstubAllGlobals();
  delete process.env.FX_GATEWAY_BASE_URL;
});

describe('listFxModels', () => {
  it('maps a gateway entry onto a suggestion, keeping the id as the wire value', async () => {
    stubCatalog([model()]);
    const out = await listFxModels();
    expect(out).toHaveLength(1);
    const m = out![0]!;
    // The id fx puts in `ai-language-model-id` — stored verbatim, no peeling.
    expect(m.id).toBe('anthropic/claude-opus-4.8');
    expect(m.label).toBe('Claude Opus 4.8');
    expect(m.upstream).toBe('anthropic');
    expect(m.contextWindow).toBe(1_000_000);
    // Per-token decimal strings become per-Mtok numbers.
    expect(m.inputCostPerMTok).toBe(5);
    expect(m.outputCostPerMTok).toBe(25);
    expect(m.releaseDate).toBe('2026-05-28');
    expect(m.modalitiesIn).toEqual(['text', 'image']);
  });

  it('drops models that cannot call tools', async () => {
    stubCatalog([model({ id: 'a/no-tools', tags: ['reasoning'] }), model()]);
    const out = await listFxModels();
    expect(out!.map((m) => m.id)).toEqual(['anthropic/claude-opus-4.8']);
  });

  it('drops non-language and non-text-emitting entries', async () => {
    stubCatalog([
      model({ id: 'a/embed', type: 'embedding' }),
      model({ id: 'a/img', modalities: { input: ['text'], output: ['image'] } }),
      model(),
    ]);
    const out = await listFxModels();
    expect(out!.map((m) => m.id)).toEqual(['anthropic/claude-opus-4.8']);
  });

  it('filters by upstream and input modality', async () => {
    stubCatalog([
      model(),
      model({ id: 'openai/gpt-x', name: 'GPT X', owned_by: 'openai' }),
      model({ id: 'anthropic/text-only', name: 'Text Only', modalities: { input: ['text'], output: ['text'] } }),
    ]);
    expect((await listFxModels({ upstream: 'openai' }))!.map((m) => m.id)).toEqual(['openai/gpt-x']);
    resetGatewayCatalogCache();
    const vision = await listFxModels({ upstream: 'anthropic', inputModality: 'image' });
    expect(vision!.map((m) => m.id)).toEqual(['anthropic/claude-opus-4.8']);
  });

  it('returns null when the catalog is unreachable so callers report unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    expect(await listFxModels()).toBeNull();
  });

  it('follows FX_GATEWAY_BASE_URL so the catalog matches the gateway fx is pointed at', async () => {
    process.env.FX_GATEWAY_BASE_URL = 'https://gw.example.test/';
    const f = stubCatalog([model()]);
    await listFxModels();
    expect(f.mock.calls[0]![0]).toBe('https://gw.example.test/coding-agent/v1/models');
  });
});
