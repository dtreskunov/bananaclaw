import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { clearNativeCatalogForTest, nativeProtocolForPackage, resolveNativeModel } from './catalog.js';

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(() => {
  clearNativeCatalogForTest();
  fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      example: {
        npm: '@ai-sdk/openai-compatible',
        api: 'https://original.example/v1',
        models: { audio: { modalities: { input: ['text', 'audio'], output: ['text'] }, limit: { context: 1000 } } },
      },
    }),
  );
});

afterEach(() => {
  fetchMock.mockRestore();
  clearNativeCatalogForTest();
  delete process.env.NATIVE_BASE_URL;
  delete process.env.NATIVE_PROTOCOL;
});

describe('native protocol resolution', () => {
  it('maps the models.dev Anthropic package to Messages', () => {
    expect(nativeProtocolForPackage('@ai-sdk/anthropic')).toBe('anthropic-messages');
  });

  it('maps OpenAI-compatible packages to Chat Completions', () => {
    expect(nativeProtocolForPackage('@openrouter/ai-sdk-provider')).toBe('openai-chat');
  });

  it('supports an explicit Anthropic endpoint for local testing', async () => {
    process.env.NATIVE_BASE_URL = 'http://127.0.0.1:3001/anthropic/v1/';
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    expect(await resolveNativeModel('local/MiniMax-M3')).toMatchObject({
      modelId: 'MiniMax-M3',
      baseURL: 'http://127.0.0.1:3001/anthropic/v1',
      protocol: 'anthropic-messages',
    });
  });

  it('retains known model capabilities and limits when only the address is overridden', async () => {
    process.env.NATIVE_BASE_URL = 'http://127.0.0.1:3001/proxy/';
    expect(await resolveNativeModel('example/audio')).toMatchObject({
      baseURL: 'http://127.0.0.1:3001/proxy',
      inputModalities: ['text', 'audio'],
      protocol: 'openai-chat',
      contextWindow: 1000,
    });
    await resolveNativeModel('example/audio');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit protocol selection independent of the catalog', async () => {
    process.env.NATIVE_BASE_URL = 'http://127.0.0.1:3001';
    process.env.NATIVE_PROTOCOL = 'anthropic-messages';
    expect(await resolveNativeModel('example/audio')).toMatchObject({
      protocol: 'anthropic-messages',
      inputModalities: ['text', 'audio'],
    });
  });

  it('does not infer capabilities for unknown custom models', async () => {
    process.env.NATIVE_BASE_URL = 'http://127.0.0.1:3001';
    expect((await resolveNativeModel('custom/audio-in-name')).inputModalities).toBeUndefined();
  });

  it('keeps custom endpoints usable with unknown capabilities during catalog failures and backs off', async () => {
    process.env.NATIVE_BASE_URL = 'http://127.0.0.1:3001';
    fetchMock.mockRejectedValue(new TypeError('network failed'));
    expect((await resolveNativeModel('example/audio')).inputModalities).toBeUndefined();
    expect((await resolveNativeModel('example/audio')).inputModalities).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete process.env.NATIVE_BASE_URL;
    await expect(resolveNativeModel('example/audio')).rejects.toThrow('catalog temporarily unavailable');
  });

  it('does not hide malformed protocol selection or unknown catalog models without an endpoint override', async () => {
    await expect(resolveNativeModel('example/missing')).rejects.toThrow('not found');
    process.env.NATIVE_BASE_URL = 'http://127.0.0.1:3001';
    process.env.NATIVE_PROTOCOL = 'invalid';
    await expect(resolveNativeModel('example/audio')).rejects.toThrow('Unsupported NATIVE_PROTOCOL');
  });
});
