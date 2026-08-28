import { afterEach, describe, expect, it } from 'bun:test';

import { nativeProtocolForPackage, resolveNativeModel } from './catalog.js';

afterEach(() => {
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
});
