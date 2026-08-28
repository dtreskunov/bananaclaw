import { describe, expect, it } from 'vitest';

import { isNativeCompatible, nativeInputModalities } from './models-dev-catalog.js';

describe('isNativeCompatible', () => {
  it('accepts an OpenAI-compatible endpoint', () => {
    expect(isNativeCompatible({ api: 'https://openrouter.ai/api/v1', npm: '@openrouter/ai-sdk-provider' }, {})).toBe(
      true,
    );
  });

  it('accepts an Anthropic-compatible endpoint', () => {
    expect(isNativeCompatible({ api: 'https://api.minimax.io/anthropic/v1', npm: '@ai-sdk/anthropic' }, {})).toBe(true);
  });

  it('rejects an unsupported package', () => {
    expect(isNativeCompatible({ api: 'https://example.test/v1', npm: '@ai-sdk/google' }, {})).toBe(false);
  });

  it('rejects unresolved endpoint templates', () => {
    expect(isNativeCompatible({ api: 'https://${REGION}.example.test/v1', npm: '@ai-sdk/openai-compatible' }, {})).toBe(
      false,
    );
  });
});

describe('nativeInputModalities', () => {
  it('projects all file types supported by OpenAI-compatible Chat', () => {
    expect(
      nativeInputModalities({ api: 'https://openrouter.ai/api/v1', npm: '@openrouter/ai-sdk-provider' }, {}, [
        'text',
        'image',
        'pdf',
        'audio',
        'video',
      ]),
    ).toEqual(['text', 'image', 'pdf', 'audio', 'video']);
  });

  it('removes audio and video from Anthropic Messages models', () => {
    expect(
      nativeInputModalities({ api: 'https://api.minimax.io/anthropic/v1', npm: '@ai-sdk/anthropic' }, {}, [
        'text',
        'image',
        'pdf',
        'audio',
        'video',
      ]),
    ).toEqual(['text', 'image', 'pdf']);
  });
});
